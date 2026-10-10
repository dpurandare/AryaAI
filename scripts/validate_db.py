#!/usr/bin/env python3
"""
Kagent — Corrected Database Validation Script
Supersedes EnerygyAIProto2/scripts/validate_db.py.

Changes vs the original:
  - AEP_SOLAR_KWH updated to match corrected 22 % CUF target (DC basis, CERC 8,766 h).
  - Solar CUF checks added: annual range, monsoon vs non-monsoon seasonal pattern,
    PPA commitment derived from corrected contract parameters.
  - CERC_HOURS constant introduced (8,766) throughout.
  - Checks added for rpo_obligation and solar_maintenance_event (Change 6) —
    supports rpo-compliance-analysis and maintenance-scheduling skills.
  See docs/db_changes.md for full rationale.

Usage:
    python validate_db.py [db_path]
    Default: ../../EnerygyAIProto2/data/kagent_sample.db

Exit code: 0 if all checks pass, 1 if any check fails.
"""

import os
import sys
import sqlite3

# ── DB path ───────────────────────────────────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB  = os.path.join(_SCRIPT_DIR, "..", "data", "kagent_sample.db")
DB_PATH     = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB

# ── ANSI colours ──────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

# ── Expected constants ────────────────────────────────────────────────────────
N_TURBINES     = 80
RATED_KW       = 2_500.0
CUT_IN         = 3.0
CUT_OUT        = 25.0
FARM_WIND      = "GJ01-WIND"
FARM_SOLAR     = "GJ01-SOLAR"
INTERVAL_MIN   = 10
INTERVALS_YEAR = 52_704           # 2024 is a leap year: 366 × 144
POI_LIMIT_KW   = 300_000.0
CERC_HOURS     = 8_766            # 365.25 × 24, per CERC PLF/CUF convention

# Wind AEP (unchanged)
AEP_WIND_KWH  = 470_000_000.0

# Solar AEP — corrected: SOLAR_DC_KW × CERC_HOURS × 0.22
SOLAR_DC_KW   = 150_000.0
AEP_SOLAR_KWH = SOLAR_DC_KW * CERC_HOURS * 0.22   # 289,278,000 kWh

# PPA solar commitment — corrected: 120 MW contracted × CERC_HOURS × 0.22
PPA_CONTRACTED_KW  = 120_000.0
PPA_SOLAR_KWH      = PPA_CONTRACTED_KW * CERC_HOURS * 0.22   # 231,422,400 kWh

# RPO obligation — TechFab (A11)
RPO_ENTITY                = "TechFab"
RPO_STATE                 = "Rajasthan"
RPO_TOTAL_CONSUMPTION_MWH = 900_000.0
RPO_PERCENTAGE            = 32.0
RPO_ANNUAL_OBLIGATION_MWH = RPO_TOTAL_CONSUMPTION_MWH * RPO_PERCENTAGE / 100.0

# Solar maintenance events — GJ01-SOLAR (A12)
OEM_INVERTER_TEMP_MAX_C = 50.0

# ── Result tracking ───────────────────────────────────────────────────────────
RESULTS: list[tuple[str, bool, str]] = []

def check(label: str, passed: bool, detail: str = "") -> bool:
    RESULTS.append((label, passed, detail))
    icon   = f"{GREEN}PASS{RESET}" if passed else f"{RED}FAIL{RESET}"
    suffix = f"  {YELLOW}{detail}{RESET}" if detail else ""
    print(f"  [{icon}] {label}{suffix}")
    return passed

def section(title: str):
    print(f"\n{BOLD}{'─'*60}{RESET}")
    print(f"{BOLD}  {title}{RESET}")
    print(f"{BOLD}{'─'*60}{RESET}")

def scalar(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]

def rows(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Schema
# ─────────────────────────────────────────────────────────────────────────────

def check_schema(conn):
    section("SCHEMA — tables and columns")

    tables = {r[0] for r in rows(conn, "SELECT name FROM sqlite_master WHERE type='table'")}

    for tbl in ["turbine_performance", "availability_status", "wind_resource", "generation_production",
                "rpo_obligation", "solar_maintenance_event"]:
        check(f"Table '{tbl}' exists", tbl in tables)

    expected_cols = {
        "turbine_performance": {
            "timestamp","turbine_id","active_power_kw","wind_speed_ms",
            "wind_direction_deg","rotor_rpm","nacelle_direction_deg",
            "ambient_temp_c","air_density_kgm3","theoretical_power_kw",
            "farm_id","oem"
        },
        "availability_status": {
            "timestamp","turbine_id","status_code","iec_category",
            "is_available","downtime_minutes","lost_energy_kwh",
            "loss_category","work_order_id"
        },
        "wind_resource": {
            "timestamp","source_type","location_id","wind_speed_ms",
            "wind_direction_deg","turbulence_intensity","shear_exponent",
            "temperature_c","pressure_hpa"
        },
        "generation_production": {
            "date","farm_id","technology","actual_generation_kwh",
            "expected_generation_kwh","aep_target_kwh","curtailment_kwh",
            "poi_export_kwh","poi_limit_kw","ppa_commitment_kwh"
        },
        "rpo_obligation": {
            "entity_name","state","year","total_consumption_mwh","rpo_percentage",
            "annual_obligation_mwh","other_re_procured_mwh","rec_purchased_mwh"
        },
        "solar_maintenance_event": {
            "event_id","farm_id","maintenance_start","maintenance_end","active_alarm",
            "inverter_temp_c","inverter_temp_spec_max_c","dust_level",
            "deferral_days_proposed","string_efficiency_pct","note"
        },
    }
    for tbl, exp in expected_cols.items():
        if tbl in tables:
            actual  = {r[1] for r in rows(conn, f"PRAGMA table_info({tbl})")}
            missing = exp - actual
            check(
                f"  '{tbl}' has all {len(exp)} expected columns",
                len(missing) == 0,
                f"missing: {missing}" if missing else "",
            )


# ─────────────────────────────────────────────────────────────────────────────
# 2. Row counts
# ─────────────────────────────────────────────────────────────────────────────

def check_row_counts(conn):
    section("ROW COUNTS")

    tp_count = scalar(conn, "SELECT COUNT(*) FROM turbine_performance")
    check(
        f"turbine_performance: {tp_count:,} rows (expect ~{N_TURBINES * INTERVALS_YEAR:,})",
        4_000_000 <= tp_count <= 4_500_000,
    )

    as_count = scalar(conn, "SELECT COUNT(*) FROM availability_status")
    check(
        "availability_status matches turbine_performance row count",
        tp_count == as_count,
        f"turbine_performance={tp_count:,}, availability_status={as_count:,}",
    )

    wr_count = scalar(conn, "SELECT COUNT(*) FROM wind_resource")
    check(
        f"wind_resource: {wr_count:,} rows (expect 500K–700K)",
        500_000 <= wr_count <= 700_000,
    )

    gp_count = scalar(conn, "SELECT COUNT(*) FROM generation_production")
    check(
        f"generation_production: {gp_count} rows (expect 730–732)",
        728 <= gp_count <= 734,
    )

    n_turbines = scalar(conn, "SELECT COUNT(DISTINCT turbine_id) FROM turbine_performance")
    check(
        f"turbine_performance: {n_turbines} unique turbine IDs (expect {N_TURBINES})",
        n_turbines == N_TURBINES,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Skill 1 — SCADA QC + KPI Engine
# ─────────────────────────────────────────────────────────────────────────────

def check_skill1(conn):
    section("SKILL 1 — SCADA QC + KPI Engine")

    monthly_plf = {
        r[0]: r[1]
        for r in rows(conn, """
            SELECT substr(timestamp,6,2) AS m,
                   AVG(active_power_kw) / ? * 100
            FROM turbine_performance
            WHERE active_power_kw >= 0
            GROUP BY m
        """, (RATED_KW,))
    }
    plf_jan = monthly_plf.get("01", 0)
    plf_may = monthly_plf.get("05", 0)
    plf_jul = monthly_plf.get("07", 0)
    check(
        f"Seasonal PLF trend: Jul ({plf_jul:.1f}%) > May ({plf_may:.1f}%) > Jan ({plf_jan:.1f}%)",
        plf_jul > plf_may > plf_jan,
    )

    annual_plf = scalar(conn, """
        SELECT AVG(active_power_kw) / ? * 100
        FROM turbine_performance WHERE active_power_kw >= 0
    """, (RATED_KW,))
    check(
        f"Annual fleet PLF {annual_plf:.1f}% within expected range 25–45%",
        25 <= annual_plf <= 45,
    )

    q1_ratio = scalar(conn, """
        SELECT AVG(active_power_kw / theoretical_power_kw)
        FROM turbine_performance
        WHERE turbine_id='T010' AND theoretical_power_kw > 100
          AND active_power_kw > 0
          AND substr(timestamp,6,2) IN ('01','02','03')
    """)
    q4_ratio = scalar(conn, """
        SELECT AVG(active_power_kw / theoretical_power_kw)
        FROM turbine_performance
        WHERE turbine_id='T010' AND theoretical_power_kw > 100
          AND active_power_kw > 0
          AND substr(timestamp,6,2) IN ('10','11','12')
    """)
    check(
        f"T010 degradation: Q1 actual/theoretical ({q1_ratio:.4f}) > Q4 ({q4_ratio:.4f})",
        q1_ratio > q4_ratio + 0.03,
        f"drop = {(q1_ratio - q4_ratio)*100:.1f}pp (expect > 3pp)",
    )

    stuck = scalar(conn, """
        SELECT COUNT(*) FROM (
            SELECT wind_speed_ms,
                   LAG(wind_speed_ms)   OVER (ORDER BY timestamp) AS p1,
                   LAG(wind_speed_ms,2) OVER (ORDER BY timestamp) AS p2
            FROM turbine_performance WHERE turbine_id='T025'
        ) WHERE wind_speed_ms = p1 AND wind_speed_ms = p2
    """)
    check(
        f"T025 stuck-sensor: {stuck} consecutive-frozen intervals (expect ≥ 10)",
        stuck >= 10,
    )

    outliers = scalar(conn, """
        SELECT COUNT(*) FROM turbine_performance
        WHERE turbine_id='T010'
          AND (active_power_kw > ? OR active_power_kw < -10)
    """, (RATED_KW * 1.04,))
    check(
        f"T010 outlier power values: {outliers} rows (expect ≥ 10)",
        outliers >= 10,
    )

    flatlines = scalar(conn, """
        SELECT COUNT(*) FROM turbine_performance
        WHERE turbine_id='T013' AND rotor_rpm = 0 AND active_power_kw > 200
    """)
    check(
        f"T013 RPM flatline during generation: {flatlines} rows (expect ≥ 15)",
        flatlines >= 15,
    )

    t033_rows = scalar(conn, "SELECT COUNT(*) FROM turbine_performance WHERE turbine_id='T033'")
    t001_rows = scalar(conn, "SELECT COUNT(*) FROM turbine_performance WHERE turbine_id='T001'")
    check(
        f"T033 has timestamp gaps: {t033_rows:,} rows vs T001 {t001_rows:,} (expect fewer)",
        t033_rows < t001_rows,
        f"missing {t001_rows - t033_rows} intervals",
    )

    dens_min = scalar(conn, "SELECT MIN(air_density_kgm3) FROM turbine_performance")
    dens_max = scalar(conn, "SELECT MAX(air_density_kgm3) FROM turbine_performance")
    check(
        f"Air density range [{dens_min:.3f}, {dens_max:.3f}] kg/m³ within [1.05, 1.30]",
        1.05 <= dens_min and dens_max <= 1.30,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Skill 2 — Power Curve Deviation Analysis
# ─────────────────────────────────────────────────────────────────────────────

def check_skill2(conn):
    section("SKILL 2 — Power Curve Deviation Analysis")

    fleet_mean = scalar(conn, """
        SELECT AVG(active_power_kw)
        FROM turbine_performance
        WHERE wind_speed_ms BETWEEN 8 AND 12
          AND active_power_kw > 0
          AND turbine_id NOT IN ('T001','T002')
    """)

    for tid, max_pct, label in [("T001", 94.0, "+15° yaw"), ("T002", 97.0, "-12° yaw")]:
        t_mean = scalar(conn, """
            SELECT AVG(active_power_kw) FROM turbine_performance
            WHERE turbine_id=? AND wind_speed_ms BETWEEN 8 AND 12 AND active_power_kw > 0
        """, (tid,))
        pct = t_mean / fleet_mean * 100
        check(
            f"{tid} ({label}) power at 8–12 m/s = {pct:.1f}% of fleet (expect < {max_pct}%)",
            pct < max_pct,
        )

    for tid, lo, hi, label in [("T001", 7.0, 22.0, "+15°"), ("T002", -22.0, -5.0, "-12°")]:
        offset = scalar(conn, """
            SELECT AVG(nacelle_direction_deg - wind_direction_deg)
            FROM turbine_performance
            WHERE turbine_id=? AND wind_speed_ms BETWEEN 5 AND 20
        """, (tid,))
        check(
            f"{tid} mean nacelle-wind offset {offset:.1f}° within [{lo}, {hi}] (expect ~{label})",
            lo <= offset <= hi,
        )

    healthy_offset = scalar(conn, """
        SELECT AVG(nacelle_direction_deg - wind_direction_deg)
        FROM turbine_performance
        WHERE turbine_id IN ('T005','T006','T007','T008','T009')
          AND wind_speed_ms BETWEEN 5 AND 20
    """)
    check(
        f"Healthy turbines mean nacelle offset {healthy_offset:.2f}° within [-5, 5]",
        -5 <= healthy_offset <= 5,
    )

    zero_below_cutin = scalar(conn, """
        SELECT COUNT(*) FROM turbine_performance
        WHERE wind_speed_ms < ? AND theoretical_power_kw > 10
    """, (CUT_IN,))
    check(
        f"theoretical_power_kw = 0 when wind < {CUT_IN} m/s: {zero_below_cutin} violations",
        zero_below_cutin == 0,
    )

    wrong_above_rated = scalar(conn, """
        SELECT COUNT(*) FROM turbine_performance
        WHERE wind_speed_ms BETWEEN 13 AND 24
          AND (theoretical_power_kw < 2200 OR theoretical_power_kw > 2600)
    """)
    check(
        f"theoretical_power_kw in [2200, 2600] kW at 13–24 m/s: {wrong_above_rated} violations",
        wrong_above_rated == 0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Skill 3 — Availability + Loss Attribution
# ─────────────────────────────────────────────────────────────────────────────

def check_skill3(conn):
    section("SKILL 3 — Availability + Loss Attribution")

    fleet_avail = scalar(conn, "SELECT AVG(is_available) * 100 FROM availability_status")
    check(
        f"Fleet time-based availability {fleet_avail:.2f}% (expect ≥ 97%)",
        fleet_avail >= 97.0,
    )

    t045_avail = scalar(conn, """
        SELECT 100.0 * SUM(is_available) / COUNT(*)
        FROM availability_status WHERE turbine_id='T045'
    """)
    check(
        f"T045 availability {t045_avail:.2f}% < fleet {fleet_avail:.2f}% (near-threshold demo)",
        t045_avail < fleet_avail - 2.0,
        f"delta = {fleet_avail - t045_avail:.2f}pp below fleet",
    )
    check(
        f"T045 availability {t045_avail:.2f}% within PPA-risk range [93, 97]%",
        93.0 <= t045_avail <= 97.0,
    )

    lowest = rows(conn, """
        SELECT turbine_id, ROUND(100.0*SUM(is_available)/COUNT(*),2)
        FROM availability_status GROUP BY turbine_id ORDER BY 2 ASC LIMIT 3
    """)
    bottom_ids = [r[0] for r in lowest]
    check(
        f"T045 is in the 3 lowest-availability turbines {[r for r in lowest]}",
        "T045" in bottom_ids,
    )

    t012_jan = scalar(conn, """
        SELECT COUNT(*) FROM availability_status
        WHERE turbine_id='T012' AND status_code=100 AND substr(timestamp,6,2)='01'
    """)
    t012_dec = scalar(conn, """
        SELECT COUNT(*) FROM availability_status
        WHERE turbine_id='T012' AND status_code=100 AND substr(timestamp,6,2)='12'
    """)
    check(
        f"T012 gearbox escalation: Dec ({t012_dec}) ≥ 2× Jan ({t012_jan})",
        t012_dec >= t012_jan * 2,
    )

    loss_cats = {r[0] for r in rows(conn, """
        SELECT DISTINCT loss_category FROM availability_status WHERE loss_category IS NOT NULL
    """)}
    expected_cats = {"Technical", "Environmental", "Grid", "Scheduled", "Force Majeure"}
    check(
        f"Loss categories present: {sorted(loss_cats)}",
        len(loss_cats) >= 4,
        f"missing: {expected_cats - loss_cats}" if expected_cats - loss_cats else "",
    )

    missing_wo = scalar(conn, """
        SELECT COUNT(*) FROM availability_status
        WHERE status_code IN (400, 401) AND work_order_id IS NULL
    """)
    check(
        f"All scheduled intervals have work_order_id: {missing_wo} missing",
        missing_wo == 0,
    )

    wrong_dt = scalar(conn, """
        SELECT COUNT(*) FROM availability_status
        WHERE is_available = 0 AND downtime_minutes != 10
    """)
    check(
        f"downtime_minutes = 10 for all unavailable intervals: {wrong_dt} violations",
        wrong_dt == 0,
    )

    zero_lost_with_wind = scalar(conn, """
        SELECT COUNT(*) FROM availability_status av
        JOIN turbine_performance tp USING(turbine_id, timestamp)
        WHERE av.is_available = 0
          AND tp.wind_speed_ms >= ?
          AND (av.lost_energy_kwh IS NULL OR av.lost_energy_kwh = 0)
    """, (CUT_IN,))
    check(
        f"lost_energy_kwh > 0 when unavailable AND wind ≥ {CUT_IN} m/s: {zero_lost_with_wind} violations",
        zero_lost_with_wind <= 10,
    )

    inconsistent = scalar(conn, """
        SELECT COUNT(*)
        FROM availability_status av
        JOIN turbine_performance tp USING(turbine_id, timestamp)
        WHERE av.status_code = 200 AND tp.wind_speed_ms >= ?
        LIMIT 100000
    """, (CUT_IN + 0.5,))
    check(
        f"Status 200 / wind inconsistencies: {inconsistent} (expect ≤ 20, from stuck sensors)",
        inconsistent <= 20,
        "stuck-sensor defect: status set before sensor overwrites reading" if inconsistent > 0 else "",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Skill 4 — Curtailment Quantification + Hybrid POI
# ─────────────────────────────────────────────────────────────────────────────

def check_skill4(conn):
    section("SKILL 4 — Curtailment Quantification + Hybrid POI")

    curt_days = scalar(conn, """
        SELECT COUNT(*) FROM generation_production
        WHERE technology='wind' AND curtailment_kwh > 0
    """)
    check(
        f"Wind curtailment on {curt_days} days (expect ≥ 25)",
        curt_days >= 25,
    )

    monsoon_pct = scalar(conn, """
        SELECT 100.0 *
            SUM(CASE WHEN substr(date,6,2) BETWEEN '06' AND '09' THEN curtailment_kwh ELSE 0 END)
            / SUM(curtailment_kwh)
        FROM generation_production WHERE technology='wind' AND curtailment_kwh > 0
    """)
    check(
        f"Curtailment in monsoon (Jun–Sep): {monsoon_pct:.1f}% (expect ≥ 80%)",
        monsoon_pct >= 80.0,
    )

    annual_curt_mwh = scalar(conn, """
        SELECT SUM(curtailment_kwh) / 1000.0 FROM generation_production WHERE technology='wind'
    """)
    check(
        f"Annual wind curtailment {annual_curt_mwh:,.0f} MWh (expect 5,000–30,000 MWh)",
        5_000 <= annual_curt_mwh <= 30_000,
    )

    solar_rows = scalar(conn, """
        SELECT COUNT(*) FROM generation_production WHERE technology='solar'
    """)
    check(
        f"Solar rows in generation_production: {solar_rows} (expect ≥ 365)",
        solar_rows >= 365,
    )

    solar_curt_days = scalar(conn, """
        SELECT COUNT(*) FROM generation_production
        WHERE technology='solar' AND curtailment_kwh > 0
    """)
    check(
        f"Solar curtailment on {solar_curt_days} days (POI hybrid attribution present)",
        solar_curt_days >= 1,
    )

    wrong_poi = scalar(conn, """
        SELECT COUNT(*) FROM generation_production
        WHERE poi_limit_kw != ? OR poi_limit_kw IS NULL
    """, (POI_LIMIT_KW,))
    check(
        f"poi_limit_kw = {POI_LIMIT_KW:,.0f} kW throughout: {wrong_poi} violations",
        wrong_poi == 0,
    )

    over_poi = scalar(conn, """
        SELECT COUNT(*) FROM (
            SELECT date, SUM(poi_export_kwh) / 24.0 AS avg_hourly_kw
            FROM generation_production GROUP BY date
        ) WHERE avg_hourly_kw > ?
    """, (POI_LIMIT_KW * 1.05,))
    total_days = scalar(conn, "SELECT COUNT(DISTINCT date) FROM generation_production")
    check(
        f"POI export ≤ limit on {total_days - over_poi}/{total_days} days",
        over_poi / max(total_days, 1) < 0.10,
        f"{over_poi} days exceed limit by > 5%",
    )

    concordance = scalar(conn, """
        SELECT 100.0 * SUM(CASE WHEN tp.active_power_kw <= 5 THEN 1 ELSE 0 END) / COUNT(*)
        FROM availability_status av
        JOIN turbine_performance tp USING(turbine_id, timestamp)
        WHERE av.status_code IN (302, 400, 401)
    """)
    check(
        f"active_power_kw ≈ 0 during curtailment/maintenance: {concordance:.1f}% (expect ≥ 95%)",
        concordance >= 95.0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 7. Skill 5 — MIS/DGR Report Generator
# ─────────────────────────────────────────────────────────────────────────────

def check_skill5(conn):
    section("SKILL 5 — MIS/DGR Report Generator (data completeness)")

    days_with_both = scalar(conn, """
        SELECT COUNT(*) FROM (
            SELECT date FROM generation_production
            GROUP BY date HAVING COUNT(DISTINCT technology) = 2
        )
    """)
    total_days = scalar(conn, "SELECT COUNT(DISTINCT date) FROM generation_production")
    check(
        f"Both wind + solar rows on every day: {days_with_both}/{total_days} days",
        days_with_both == total_days,
    )

    annual_wind = scalar(conn, """
        SELECT SUM(actual_generation_kwh) FROM generation_production WHERE technology='wind'
    """)
    wind_pct = annual_wind / AEP_WIND_KWH * 100
    check(
        f"Annual wind generation {annual_wind/1e6:.0f} GWh = {wind_pct:.0f}% of P50 target",
        65 <= wind_pct <= 150,
        f"P50 target = {AEP_WIND_KWH/1e6:.0f} GWh",
    )

    # ── Solar CUF checks (corrected) ──────────────────────────────────────────

    annual_solar = scalar(conn, """
        SELECT SUM(actual_generation_kwh) FROM generation_production WHERE technology='solar'
    """)
    solar_cuf = (annual_solar or 0) / (SOLAR_DC_KW * CERC_HOURS) * 100
    check(
        f"Annual solar CUF {solar_cuf:.1f}% within realistic range [18%, 26%] "
        f"(Omji: 20-25% for static-mount Rajasthan/Gujarat, CERC 8,766 h)",
        18 <= solar_cuf <= 26,
        f"actual = {annual_solar/1e6:.1f} GWh, target AEP = {AEP_SOLAR_KWH/1e6:.1f} GWh",
    )

    solar_pct = (annual_solar or 0) / AEP_SOLAR_KWH * 100
    check(
        f"Annual solar generation {annual_solar/1e6:.0f} GWh = {solar_pct:.0f}% of AEP target",
        70 <= solar_pct <= 130,
        f"AEP target = {AEP_SOLAR_KWH/1e6:.1f} GWh",
    )

    # Monsoon months (Jun–Aug) must show materially lower daily generation than
    # non-monsoon to verify the irradiance model captured seasonal variation.
    avg_daily_monsoon = scalar(conn, """
        SELECT AVG(actual_generation_kwh)
        FROM generation_production
        WHERE technology='solar'
          AND substr(date,6,2) IN ('06','07','08')
    """) or 0
    avg_daily_non_monsoon = scalar(conn, """
        SELECT AVG(actual_generation_kwh)
        FROM generation_production
        WHERE technology='solar'
          AND substr(date,6,2) NOT IN ('06','07','08','09')
    """) or 1  # avoid division by zero

    monsoon_ratio = avg_daily_monsoon / avg_daily_non_monsoon
    check(
        f"Monsoon solar avg ({avg_daily_monsoon/1e3:.0f} MWh/day) < "
        f"non-monsoon avg ({avg_daily_non_monsoon/1e3:.0f} MWh/day) — seasonal irradiance pattern correct",
        monsoon_ratio < 0.80,
        f"ratio = {monsoon_ratio:.2f} (expect < 0.80)",
    )

    # At least some months must fall below the PPA CUF guarantee (22 %).
    # ppa_commitment_kwh is a daily value; derive daily threshold from annual PPA.
    daily_ppa = PPA_SOLAR_KWH / 365.0
    months_below_ppa = scalar(conn, """
        SELECT COUNT(*) FROM (
            SELECT substr(date,6,2) AS m,
                   AVG(actual_generation_kwh) AS avg_daily
            FROM generation_production
            WHERE technology='solar'
            GROUP BY m
        ) WHERE avg_daily < ?
    """, (daily_ppa,))
    check(
        f"Months with average daily generation below PPA commitment: {months_below_ppa} "
        f"(expect ≥ 2 — monsoon shortfall scenario for Skills 6-8)",
        months_below_ppa >= 2,
    )

    # ppa_commitment_kwh populated and matches corrected value (within 1 %)
    null_ppa = scalar(conn, """
        SELECT COUNT(*) FROM generation_production WHERE ppa_commitment_kwh IS NULL
    """)
    check(
        f"ppa_commitment_kwh populated throughout: {null_ppa} NULL rows",
        null_ppa == 0,
    )

    ppa_solar_in_db = scalar(conn, """
        SELECT AVG(ppa_commitment_kwh) FROM generation_production WHERE technology='solar'
    """) or 0
    expected_daily_ppa = PPA_SOLAR_KWH / 365.0
    ppa_err_pct = abs(ppa_solar_in_db - expected_daily_ppa) / expected_daily_ppa * 100
    check(
        f"Solar ppa_commitment_kwh ({ppa_solar_in_db:,.0f} kWh/day) matches "
        f"corrected contract ({expected_daily_ppa:,.0f} kWh/day) within 1%",
        ppa_err_pct < 1.0,
        f"error = {ppa_err_pct:.2f}%",
    )

    # Wind resource: met mast present
    mm_rows = scalar(conn, "SELECT COUNT(*) FROM wind_resource WHERE source_type='met_mast'")
    check(
        f"Met mast (MM-GJ01) rows in wind_resource: {mm_rows:,} (expect ≥ 50,000)",
        mm_rows >= 50_000,
    )

    scada_locs = scalar(conn, """
        SELECT COUNT(DISTINCT location_id) FROM wind_resource WHERE source_type='scada'
    """)
    check(
        f"SCADA nacelle anemometer locations: {scada_locs} (expect 10)",
        scada_locs == 10,
    )

    tp_start = scalar(conn, "SELECT MIN(substr(timestamp,1,10)) FROM turbine_performance")
    tp_end   = scalar(conn, "SELECT MAX(substr(timestamp,1,10)) FROM turbine_performance")
    check(
        f"turbine_performance spans full year: {tp_start} → {tp_end}",
        tp_start == "2024-01-01" and tp_end == "2024-12-31",
    )

    gp_start = scalar(conn, "SELECT MIN(date) FROM generation_production")
    gp_end   = scalar(conn, "SELECT MAX(date) FROM generation_production")
    check(
        f"generation_production spans full year: {gp_start} → {gp_end}",
        gp_start == "2024-01-01" and gp_end == "2024-12-31",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 8. RPO Compliance + Maintenance Scheduling (new skills, Change 6)
# ─────────────────────────────────────────────────────────────────────────────

def check_rpo_and_maintenance(conn):
    section("SKILL — RPO Compliance + Maintenance Scheduling (rpo_obligation, solar_maintenance_event)")

    rpo_count = scalar(conn, "SELECT COUNT(*) FROM rpo_obligation")
    check(f"rpo_obligation: {rpo_count} row (expect 1)", rpo_count == 1)

    if rpo_count == 1:
        entity, state, total_cons, pct, obligation = conn.execute("""
            SELECT entity_name, state, total_consumption_mwh, rpo_percentage, annual_obligation_mwh
            FROM rpo_obligation
        """).fetchone()
        check(f"rpo_obligation entity/state = {entity}/{state} (expect {RPO_ENTITY}/{RPO_STATE})",
              entity == RPO_ENTITY and state == RPO_STATE)

        expected_obligation = total_cons * pct / 100.0
        err_pct = abs(obligation - expected_obligation) / expected_obligation * 100
        check(
            f"annual_obligation_mwh ({obligation:,.0f}) = total_consumption × rpo_percentage "
            f"({expected_obligation:,.0f}) within 1%",
            err_pct < 1.0,
            f"error = {err_pct:.2f}%",
        )
        check(
            f"rpo_percentage {pct:.0f}% within RERC realistic range [30, 35]% (rpo-mechanics-india.md)",
            30.0 <= pct <= 35.0,
        )

    sme_count = scalar(conn, "SELECT COUNT(*) FROM solar_maintenance_event")
    check(f"solar_maintenance_event: {sme_count} rows (expect 3)", sme_count == 3)

    gate_fail_rows = rows(conn, """
        SELECT event_id, active_alarm, inverter_temp_c, inverter_temp_spec_max_c, dust_level
        FROM solar_maintenance_event
        WHERE active_alarm = 1 OR inverter_temp_c > inverter_temp_spec_max_c OR dust_level = 'High'
    """)
    check(
        f"At least one gate-failure event present: {[r[0] for r in gate_fail_rows]}",
        len(gate_fail_rows) >= 1,
    )

    gate_pass_rows = rows(conn, """
        SELECT event_id FROM solar_maintenance_event
        WHERE active_alarm = 0 AND inverter_temp_c <= inverter_temp_spec_max_c AND dust_level != 'High'
    """)
    check(
        f"At least one all-gates-pass event present: {[r[0] for r in gate_pass_rows]}",
        len(gate_pass_rows) >= 1,
    )

    monsoon_events = rows(conn, """
        SELECT event_id, substr(maintenance_start,6,2) AS m
        FROM solar_maintenance_event
        WHERE substr(maintenance_start,6,2) IN ('06','07','08')
    """)
    if monsoon_events:
        avg_daily_monsoon = scalar(conn, """
            SELECT AVG(actual_generation_kwh) FROM generation_production
            WHERE technology='solar' AND substr(date,6,2) IN ('06','07','08')
        """) or 0
        avg_daily_annual = scalar(conn, """
            SELECT AVG(actual_generation_kwh) FROM generation_production WHERE technology='solar'
        """) or 1
        check(
            f"Monsoon-timed event {[r[0] for r in monsoon_events]} sits in a below-average "
            f"generation month ({avg_daily_monsoon/1e3:.0f} MWh/day vs annual avg "
            f"{avg_daily_annual/1e3:.0f} MWh/day) — CUF-at-risk scenario is real, not just labeled",
            avg_daily_monsoon < avg_daily_annual,
        )
    else:
        check("At least one event timed in a monsoon month (Jun-Aug) for the CUF-at-risk test", False)

    null_deferral = scalar(conn, """
        SELECT COUNT(*) FROM solar_maintenance_event
        WHERE deferral_days_proposed IS NULL OR deferral_days_proposed > 30
    """)
    check(
        f"deferral_days_proposed populated and within the 30-day max: {null_deferral} violations",
        null_deferral == 0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 9. Cross-table Referential Integrity
# ─────────────────────────────────────────────────────────────────────────────

def check_integrity(conn):
    section("CROSS-TABLE REFERENTIAL INTEGRITY")

    tp_ids = {r[0] for r in rows(conn, "SELECT DISTINCT turbine_id FROM turbine_performance")}
    as_ids = {r[0] for r in rows(conn, "SELECT DISTINCT turbine_id FROM availability_status")}
    check(
        "Turbine IDs match between turbine_performance and availability_status",
        tp_ids == as_ids,
        f"in TP only: {tp_ids - as_ids}, in AS only: {as_ids - tp_ids}" if tp_ids != as_ids else "",
    )

    known_codes   = {0,100,101,102,103,104,200,201,202,300,301,302,400,401,500}
    unknown_codes = {
        r[0]
        for r in rows(conn, "SELECT DISTINCT status_code FROM availability_status")
        if r[0] not in known_codes
    }
    check(
        f"All status_codes are from the 15-code dictionary: {len(unknown_codes)} unknown",
        len(unknown_codes) == 0,
        str(unknown_codes) if unknown_codes else "",
    )

    null_iec = scalar(conn, "SELECT COUNT(*) FROM availability_status WHERE iec_category IS NULL")
    check(f"iec_category never NULL: {null_iec} violations", null_iec == 0)

    null_avail = scalar(conn, "SELECT COUNT(*) FROM availability_status WHERE is_available IS NULL")
    check(f"is_available never NULL: {null_avail} violations", null_avail == 0)

    farms = {r[0] for r in rows(conn, "SELECT DISTINCT farm_id FROM turbine_performance")}
    check(
        f"farm_id in turbine_performance: {farms}",
        farms == {"GJ01-WIND"},
    )

    techs = {r[0] for r in rows(conn, "SELECT DISTINCT technology FROM generation_production")}
    check(
        f"technology values in generation_production: {techs}",
        techs == {"wind", "solar"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(DB_PATH):
        print(f"{RED}ERROR: Database not found: {DB_PATH}{RESET}")
        print("Run scripts/generate_sample_db.py first.")
        sys.exit(1)

    size_mb = os.path.getsize(DB_PATH) / 1_048_576
    print(f"{BOLD}Kagent — Database Validation (corrected){RESET}")
    print(f"Database      : {DB_PATH}  ({size_mb:.1f} MB)")
    print(f"Solar AEP ref : {AEP_SOLAR_KWH/1e6:.1f} GWh  "
          f"({SOLAR_DC_KW/1000:.0f} MW DC × {CERC_HOURS} h × 22 % CUF)")
    print(f"Solar PPA ref : {PPA_SOLAR_KWH/1e6:.1f} GWh  "
          f"({PPA_CONTRACTED_KW/1000:.0f} MW contracted × {CERC_HOURS} h × 22 % CUF)")

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA query_only = ON")

    check_schema(conn)
    check_row_counts(conn)
    check_skill1(conn)
    check_skill2(conn)
    check_skill3(conn)
    check_skill4(conn)
    check_skill5(conn)
    check_rpo_and_maintenance(conn)
    check_integrity(conn)

    conn.close()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = sum(1 for _, ok, _ in RESULTS if not ok)
    total  = len(RESULTS)

    print(f"\n{BOLD}{'═'*60}{RESET}")
    print(f"{BOLD}  RESULT: {passed}/{total} checks passed", end="")
    if failed == 0:
        print(f"  {GREEN}ALL PASS{RESET}{BOLD}{RESET}")
    else:
        print(f"  {RED}{failed} FAILED{RESET}")
        print(f"\n  Failed checks:")
        for label, ok, detail in RESULTS:
            if not ok:
                d = f"  ({detail})" if detail else ""
                print(f"    {RED}✗{RESET} {label}{d}")
    print(f"{BOLD}{'═'*60}{RESET}\n")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
