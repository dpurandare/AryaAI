#!/usr/bin/env python3
"""
Kagent — Corrected Sample Database Generator
Supersedes EnerygyAIProto2/scripts/generate_sample_db.py.

Solar-side corrections vs the original script:
  1. Solar generation computed from a physically-grounded irradiance model instead
     of a hand-tuned monthly-fraction table (fractions summed to 1.055, not 1.0).
  2. AEP_SOLAR_KWH derived from SOLAR_DC_KW × CERC_HOURS × SOLAR_TARGET_CUF (22 %).
  3. PPA_SOLAR_KWH derived from the corrected TechFab contract terms:
     120 MW contracted × CERC_HOURS (8,766 h) × 0.22 = 231,422,400 kWh.
  4. MONTHLY_SOLAR_FRACTION removed entirely.
  5. Added rpo_obligation (A11) and solar_maintenance_event (A12) tables to
     support the rpo-compliance-analysis and maintenance-scheduling skills
     (see docs/db_changes.md, "TechFab RPO and Maintenance Scenario").

Solar model priority:
  A. pvlib (Ineichen clear-sky + monthly cloud derates) — install with:
         pip install pvlib
  B. Monthly GHI table fallback (MNRE/NIWE solar resource data for western
     Gujarat) — used automatically when pvlib is absent.

See docs/db_changes.md for full rationale and methodology.

Usage:
    python generate_sample_db.py [output_path]
    Default output: ../../EnerygyAIProto2/data/kagent_sample.db

Dependencies (core): numpy, pandas  (pip install numpy pandas)
Dependencies (recommended): pvlib   (pip install pvlib)
"""

import os
import sys
import math
import sqlite3
import random
import warnings
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

# Optional pvlib — graceful fallback if not installed
try:
    import pvlib
    _PVLIB_AVAILABLE = True
except ImportError:
    _PVLIB_AVAILABLE = False
    warnings.warn(
        "pvlib not found — using GHI-table fallback for solar generation.\n"
        "Install pvlib for higher-fidelity simulation: pip install pvlib",
        stacklevel=2,
    )

# ── Reproducibility ───────────────────────────────────────────────────────────
RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)
random.seed(RANDOM_SEED)

# ── Output path ───────────────────────────────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB   = os.path.join(_SCRIPT_DIR, "..", "data", "kagent_sample.db")
DB_PATH      = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB

# ── Simulation window ─────────────────────────────────────────────────────────
SIM_YEAR     = 2024
START_DT     = datetime(SIM_YEAR, 1, 1, 0, 0, 0)
END_DT       = datetime(SIM_YEAR, 12, 31, 23, 50, 0)
INTERVAL_MIN = 10

# ── CERC convention ───────────────────────────────────────────────────────────
# CERC uses 8,766 hours/year (= 365.25 × 24) for all CUF / PLF calculations.
CERC_HOURS = 8_766

# ── Farm config (A1, A5) ──────────────────────────────────────────────────────
FARM_WIND  = "GJ01-WIND"
FARM_SOLAR = "GJ01-SOLAR"
OEM        = "GE"
N_TURBINES = 80
TURBINE_IDS = [f"T{i:03d}" for i in range(1, N_TURBINES + 1)]

# ── Turbine specs (A1) ────────────────────────────────────────────────────────
RATED_KW  = 2_500.0
ROTOR_D   = 132.0
CUT_IN    = 3.0
RATED_WS  = 12.5
CUT_OUT   = 25.0
RATED_RPM = 14.0

# ── Contract / financial ──────────────────────────────────────────────────────
POI_LIMIT_KW = 300_000.0

# Wind AEP and PPA (unchanged from original)
AEP_WIND_KWH = 470_000_000.0
PPA_WIND_KWH = 400_000_000.0
WIND_TARIFF  = 2.50

# Solar AEP and PPA — derived from corrected parameters (see db_changes.md)
SOLAR_TARGET_CUF   = 0.22          # 22 % CUF per Omji's correction (DC-nameplate basis)
SOLAR_DC_KW        = 150_000.0     # 150 MW DC nameplate
SOLAR_AC_KW        = 130_000.0     # 130 MW AC inverter limit
SOLAR_PR           = 0.82          # system performance ratio (soiling, wiring, inverter)
PPA_CONTRACTED_KW  = 120_000.0     # contracted MW from TechFab corrected scenario

AEP_SOLAR_KWH = SOLAR_DC_KW * CERC_HOURS * SOLAR_TARGET_CUF   # 289,278,000 kWh
PPA_SOLAR_KWH = PPA_CONTRACTED_KW * CERC_HOURS * SOLAR_TARGET_CUF  # 231,422,400 kWh
SOLAR_TARIFF  = 2.20

# ── RPO obligation — TechFab open-access consumer (A11) ──────────────────────
# TechFab is the same C&I offtaker as the solar PPA (Kagent_4Tier_Validation_Reference.md).
# RPO is a separate regulatory track from the PPA CUF guarantee, computed on
# TechFab's own consumption — not a fixed industry-wide figure (rpo-mechanics-india.md).
RPO_ENTITY                = "TechFab"
RPO_STATE                 = "Rajasthan"
RPO_TOTAL_CONSUMPTION_MWH = 900_000.0   # annual C&I load
RPO_PERCENTAGE            = 32.0        # % of consumption required from RE (Rajasthan SERC)
RPO_ANNUAL_OBLIGATION_MWH = RPO_TOTAL_CONSUMPTION_MWH * RPO_PERCENTAGE / 100.0  # 288,000 MWh
RPO_OTHER_RE_MWH          = 42_000.0    # physical RE procured outside the GJ01 PPA
RPO_REC_PURCHASED_MWH     = 8_000.0     # RECs purchased on IEX/PXIL/HPX

# ── Wind resource (A4) ────────────────────────────────────────────────────────
K_WEIBULL = 2.1
MONTHLY_WIND_MEAN = {
    1:5.8, 2:5.5, 3:6.0, 4:6.8, 5:7.8,  6:9.2,
    7:10.8,8:10.2,9:8.5,10:6.5,11:5.5, 12:5.5
}
MONTHLY_TEMP = {
    1:20, 2:22, 3:27, 4:33, 5:38, 6:34,
    7:30, 8:29, 9:30,10:28,11:23,12:20
}
MONTHLY_PRESSURE = {
    1:1013,2:1012,3:1010,4:1008,5:1007,6:1009,
    7:1010,8:1010,9:1011,10:1012,11:1012,12:1013
}
MONTHLY_WIND_DIR = {
    1:310,2:320,3:290,4:270,5:250,6:230,
    7:225,8:230,9:245,10:280,11:310,12:320
}

# ── Power curve (A2) ─────────────────────────────────────────────────────────
PC_WS = np.array([0.0, 3.0, 4.0,  5.0,  6.0,  7.0,   8.0,    9.0,   10.0,  11.0,  12.0,  12.5,   25.0, 25.1])
PC_KW = np.array([0.0,15.0,85.0,210.0,420.0,720.0,1100.0, 1550.0, 1980.0,2300.0,2450.0,2500.0, 2500.0,  0.0])

# ── Status code map (A3) ─────────────────────────────────────────────────────
STATUS_MAP = {
    0:   ("Running",      True,  None),
    100: ("Technical",    False, "Technical"),
    101: ("Technical",    False, "Technical"),
    102: ("Technical",    False, "Technical"),
    103: ("Technical",    False, "Technical"),
    104: ("Technical",    False, "Technical"),
    200: ("Environmental",True,  "Environmental"),
    201: ("Environmental",True,  "Environmental"),
    202: ("Environmental",True,  "Environmental"),
    300: ("Grid",         False, "Grid"),
    301: ("Grid",         False, "Grid"),
    302: ("Grid",         False, "Grid"),
    400: ("Scheduled",    False, "Scheduled"),
    401: ("Scheduled",    False, "Scheduled"),
    500: ("ForceMajeure", False, "Force Majeure"),
}

# ── Turbine-specific patterns (A9) ────────────────────────────────────────────
YAW_ERRORS = {"T001": 15.0, "T002": -12.0}
DEGRADATION = {
    "T010": 0.005,
    "T011": 0.008,
    "T013": 0.012,
}
T012_FAULTS_PER_MONTH = {1:1,2:1,3:2,4:2,5:2,6:3,7:3,8:4,9:4,10:5,11:5,12:6}

# ── SCADA defect targets (A8) ─────────────────────────────────────────────────
STUCK_SENSOR_TURBINES  = ["T025", "T041", "T067"]
OUTLIER_POWER_TURBINES = ["T010", "T011"]
RPM_FLATLINE_TURBINE   = "T013"
TIMESTAMP_GAP_TURBINE  = "T033"
PPA_RISK_TURBINE       = "T045"

# ── Maintenance schedule (A10) ────────────────────────────────────────────────
MAINT_MONTH = {
    1: range(1,  7),  2: range(7, 14),  3: range(14, 21),
    4: range(21, 28), 5: range(28, 35), 6: range(35, 41),
    7: range(41, 48), 8: range(48, 55), 9: range(55, 62),
   10: range(62, 69),11: range(69, 75),12: range(75, 81),
}

def build_maintenance_windows():
    windows = {}
    for month, nums in MAINT_MONTH.items():
        for n in nums:
            tid   = f"T{n:03d}"
            start = datetime(SIM_YEAR, month, 10, 8, 0)
            end   = start + timedelta(days=2)
            wo    = f"WO-GJ01-{SIM_YEAR}-{n:04d}"
            windows[tid] = (start, end, wo)
    return windows

MAINT_WINDOWS = build_maintenance_windows()

# ── Solar maintenance deferral events — GJ01-SOLAR (A12) ─────────────────────
# Three scheduled preventive-maintenance events for the maintenance-scheduling
# skill's three-gate rule (active alarm / inverter temp / dust) and CUF-at-risk
# check (maintenance-scheduling.md, inverter-maintenance-deferral-criteria.md).
# Mirrors the "Plant 2 inverter, heavy cloud coming" scenario in
# Kagent_4Tier_Validation_Reference.md, retimed to GJ01-SOLAR's actual monsoon
# months (MONTHLY_CLOUD_DERATE) rather than the doc's illustrative numbers.
OEM_INVERTER_TEMP_MAX_C = 50.0

# (event_id, month, day, active_alarm, inverter_temp_c, dust_level, note)
SOLAR_MAINTENANCE_EVENTS = [
    ("SM-2024-01", 2, 12, 0, 42.0, "Low",  "clean case — non-monsoon, economic test decides"),
    ("SM-2024-02", 7, 10, 0, 43.0, "Low",  "gates pass, but July is peak monsoon — CUF-at-risk test"),
    ("SM-2024-03", 9, 5,  1, 52.0, "Low",  "active alarm + thermal anomaly — must proceed regardless"),
]
SOLAR_MAINT_DEFERRAL_DAYS   = 10    # proposed deferral length (within the 30-day max)
SOLAR_MAINT_STRING_EFF_PCT  = 80.0  # expected string efficiency during deferral (AJB dropout)

# ─────────────────────────────────────────────────────────────────────────────
# Solar generation — irradiance model
# ─────────────────────────────────────────────────────────────────────────────

# GJ01-SOLAR site coordinates (Surajbari area, western Gujarat)
SOLAR_LAT     = 23.3      # degrees N
SOLAR_LON     = 69.0      # degrees E
SOLAR_ALT_M   = 20        # metres ASL
SOLAR_TILT    = 23.0      # fixed-tilt panel angle (≈ latitude)
SOLAR_AZIMUTH = 180.0     # south-facing
SOLAR_TZ      = "Asia/Kolkata"

# --- pvlib path: monthly cloud-cover derates applied on top of clear-sky ---
# Reduces Ineichen clear-sky to approximate actual GHI for western Gujarat.
# Calibrated so that annual average (clear-sky × derate × PR) ≈ 22 % CUF.
MONTHLY_CLOUD_DERATE = {
    1: 0.92,   # Jan — dry winter, minimal cloud
    2: 0.94,   # Feb — clearest month
    3: 0.93,   # Mar — clear pre-season
    4: 0.91,   # Apr — mild haze beginning
    5: 0.86,   # May — pre-monsoon haze + occasional storm
    6: 0.65,   # Jun — monsoon onset, heavy cloud
    7: 0.60,   # Jul — peak monsoon, lowest irradiance
    8: 0.63,   # Aug — monsoon persisting
    9: 0.78,   # Sep — monsoon withdrawal, clearing
   10: 0.90,   # Oct — post-monsoon, near-clear
   11: 0.92,   # Nov — clear autumn
   12: 0.92,   # Dec — clear winter
}

# --- Fallback path (no pvlib): monthly average daily GHI (kWh/m²/day) ---
# Source: MNRE/NIWE solar resource atlas, western Gujarat (Kutch/Surajbari zone).
# Values represent actual (cloud-inclusive) GHI, so no additional cloud derate needed.
MONTHLY_GHI_KWH_M2_DAY = {
    1:  6.0,   # Jan
    2:  7.0,   # Feb
    3:  7.8,   # Mar
    4:  8.2,   # Apr — peak irradiance
    5:  7.8,   # May
    6:  5.0,   # Jun — monsoon onset
    7:  4.2,   # Jul — peak monsoon
    8:  4.8,   # Aug
    9:  5.8,   # Sep — monsoon withdrawal
   10:  7.0,   # Oct
   11:  6.5,   # Nov
   12:  5.8,   # Dec
}

# Ratio of plane-of-array (23° south-facing) irradiance to horizontal GHI, by month.
# Higher in winter (low sun angle → tilt gain larger), near unity in summer.
MONTHLY_TILT_FACTOR = {
    1: 1.18, 2: 1.13, 3: 1.06, 4: 0.97, 5: 0.95,
    6: 0.93, 7: 0.94, 8: 0.96, 9: 1.01, 10: 1.09, 11: 1.16, 12: 1.20,
}


def build_solar_generation_pvlib(sim_year: int) -> dict:
    """
    Compute daily solar generation for GJ01-SOLAR using pvlib Ineichen clear-sky
    model with monthly cloud-cover derates. Returns dict of
    date_str -> {'s_exp': kWh (clear-sky baseline), 's_clearsky': kWh (raw clear-sky)}.
    """
    loc = pvlib.location.Location(
        latitude=SOLAR_LAT, longitude=SOLAR_LON,
        tz=SOLAR_TZ, altitude=SOLAR_ALT_M, name="GJ01-SOLAR",
    )
    idx = pd.date_range(
        start=f"{sim_year}-01-01",
        end=f"{sim_year}-12-31 23:00",
        freq="h",
        tz=SOLAR_TZ,
    )
    cs     = loc.get_clearsky(idx, model="ineichen")
    solpos = loc.get_solarposition(idx)
    poa    = pvlib.irradiance.get_total_irradiance(
        surface_tilt=SOLAR_TILT,
        surface_azimuth=SOLAR_AZIMUTH,
        solar_zenith=solpos["apparent_zenith"],
        solar_azimuth=solpos["azimuth"],
        dni=cs["dni"],
        ghi=cs["ghi"],
        dhi=cs["dhi"],
    )
    # DC power (kW): POA [W/m²] / 1000 × DC nameplate × PR
    dc_kw = (poa["poa_global"] / 1000.0) * SOLAR_DC_KW * SOLAR_PR
    dc_kw = dc_kw.clip(lower=0.0)
    # AC clip at inverter limit
    ac_kw = dc_kw.clip(upper=SOLAR_AC_KW)
    # Daily energy (kWh) = sum of hourly kW values
    ac_daily = ac_kw.resample("D").sum()

    result = {}
    for date, val in ac_daily.items():
        result[date.strftime("%Y-%m-%d")] = {"s_clearsky": float(val)}
    return result


def build_solar_generation_fallback(sim_year: int) -> dict:
    """
    GHI-table fallback solar model for when pvlib is not installed.
    Uses published MNRE/NIWE monthly average GHI for western Gujarat,
    converted to POA via monthly tilt factors, then DC→AC with PR and clip.
    Returns dict of date_str -> {'s_exp': kWh}.
    """
    result = {}
    date = datetime(sim_year, 1, 1)
    end  = datetime(sim_year, 12, 31)
    while date <= end:
        m   = date.month
        poa = MONTHLY_GHI_KWH_M2_DAY[m] * MONTHLY_TILT_FACTOR[m]   # kWh/m²/day
        # DC energy: POA × DC nameplate × PR
        dc_kwh = poa * SOLAR_DC_KW * SOLAR_PR
        # AC limit: 130 MW AC for ~10 effective sun hours (conservative daily cap)
        ac_kwh = min(dc_kwh, SOLAR_AC_KW * 10.0)
        result[date.strftime("%Y-%m-%d")] = {"s_clearsky": float(ac_kwh)}
        date += timedelta(days=1)
    return result


def build_solar_generation(sim_year: int) -> dict:
    """Returns daily solar generation dict using pvlib or the GHI-table fallback."""
    if _PVLIB_AVAILABLE:
        print("  Solar model : pvlib Ineichen clear-sky + monthly cloud derates")
        return build_solar_generation_pvlib(sim_year)
    print("  Solar model : GHI-table fallback (MNRE/NIWE western Gujarat)")
    return build_solar_generation_fallback(sim_year)


# ─────────────────────────────────────────────────────────────────────────────
# Helper functions (wind side — unchanged from original)
# ─────────────────────────────────────────────────────────────────────────────

def power_from_wind(ws: np.ndarray, density: np.ndarray | None = None) -> np.ndarray:
    p = np.interp(ws, PC_WS, PC_KW)
    if density is not None:
        p = p * (density / 1.225)
    return p

def weibull_wind(n: int, mean_ms: float) -> np.ndarray:
    c = mean_ms / math.gamma(1.0 + 1.0 / K_WEIBULL)
    return np.random.weibull(K_WEIBULL, n) * c

def calc_rpm(ws: np.ndarray) -> np.ndarray:
    tsr = 7.5
    rpm = np.clip(tsr * ws / (math.pi * ROTOR_D) * 60.0, 0.0, RATED_RPM)
    rpm = np.where(ws >= RATED_WS, RATED_RPM, rpm)
    rpm = np.where(ws < CUT_IN, 0.0, rpm)
    return rpm

def calc_density(temp_c: float, pressure_hpa: float) -> float:
    return (pressure_hpa * 100.0) / (287.05 * (temp_c + 273.15))

def ts_to_str(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d %H:%M:%S")


# ─────────────────────────────────────────────────────────────────────────────
# Build full timestamp array
# ─────────────────────────────────────────────────────────────────────────────

def build_timestamps() -> list[datetime]:
    ts  = []
    cur = START_DT
    while cur <= END_DT:
        ts.append(cur)
        cur += timedelta(minutes=INTERVAL_MIN)
    return ts


# ─────────────────────────────────────────────────────────────────────────────
# Farm-level wind base
# ─────────────────────────────────────────────────────────────────────────────

def build_farm_wind_base(timestamps: list[datetime]) -> np.ndarray:
    result = np.empty(len(timestamps))
    for i, ts in enumerate(timestamps):
        result[i] = weibull_wind(1, MONTHLY_WIND_MEAN[ts.month])[0]
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Curtailment event schedule (A7)
# ─────────────────────────────────────────────────────────────────────────────

def build_curtailment_schedule(timestamps: list[datetime]) -> dict:
    curt   = {}
    ts_set = set(ts_to_str(t) for t in timestamps)

    grid_events = [
        (6,  3), (6, 11), (6, 19),
        (7,  2), (7,  8), (7, 14), (7, 18), (7, 22), (7, 26), (7, 30),
        (8,  4), (8,  9), (8, 13), (8, 17), (8, 21), (8, 25), (8, 29),
        (9,  5), (9, 10), (9, 15), (9, 20), (9, 25),
    ]
    for month, day in grid_events:
        start = datetime(SIM_YEAR, month, day, 2, 0)
        dur   = random.randint(18, 24)
        for k in range(dur):
            s = ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN))
            if s in ts_set:
                curt[s] = "grid"

    poi_events = [
        (6, 15), (6, 25),
        (7,  5), (7, 12), (7, 19), (7, 24),
        (8,  6), (8, 16), (8, 23),
        (9,  3), (9,  9), (9, 17), (9, 24),
    ]
    for month, day in poi_events:
        start = datetime(SIM_YEAR, month, day, 12, 0)
        dur   = random.randint(12, 18)
        for k in range(dur):
            s = ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN))
            if s in ts_set and s not in curt:
                curt[s] = "poi"

    return curt


# ─────────────────────────────────────────────────────────────────────────────
# T012 and T045 fault windows
# ─────────────────────────────────────────────────────────────────────────────

def build_t012_faults() -> set:
    fault_ts = set()
    for month, n_faults in T012_FAULTS_PER_MONTH.items():
        days_in_month = (datetime(SIM_YEAR, month % 12 + 1, 1) - timedelta(days=1)).day \
                        if month < 12 else 31
        fault_days = sorted(random.sample(range(1, days_in_month + 1), min(n_faults, days_in_month)))
        for d in fault_days:
            start = datetime(SIM_YEAR, month, d, random.randint(0, 18), 0)
            dur   = random.randint(24, 48)
            for k in range(dur):
                fault_ts.add(ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN)))
    return fault_ts


def build_t045_faults() -> set:
    fault_ts = set()
    for month in range(1, 13):
        n = 5 if month in (6, 7, 8, 9) else 2
        days_in_month = (datetime(SIM_YEAR, month % 12 + 1, 1) - timedelta(days=1)).day \
                        if month < 12 else 31
        chosen_days = random.sample(range(1, days_in_month + 1), min(n, days_in_month))
        for d in chosen_days:
            start = datetime(SIM_YEAR, month, d, random.randint(0, 16), 0)
            dur   = random.randint(36, 60)
            for k in range(dur):
                fault_ts.add(ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN)))
    return fault_ts


# ─────────────────────────────────────────────────────────────────────────────
# SCADA defect windows (A8)
# ─────────────────────────────────────────────────────────────────────────────

def build_stuck_sensor_windows() -> dict:
    result = {}
    for tid in STUCK_SENSOR_TURBINES:
        stuck_ts = set()
        for _ in range(8):
            month    = random.randint(1, 12)
            day      = random.randint(1, 28)
            start    = datetime(SIM_YEAR, month, day, random.randint(0, 20), 0)
            dur      = random.randint(3, 8)
            stuck_val = round(random.uniform(3.5, 9.0), 2)
            for k in range(dur):
                t = ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN))
                stuck_ts.add((t, stuck_val))
        result[tid] = stuck_ts
    return result


def build_timestamp_gaps() -> set:
    gaps = set()
    gap_events = [(3, 15, 6, 14), (7, 22, 2, 6), (10, 8, 4, 18)]
    for month, day, hour, dur in gap_events:
        start = datetime(SIM_YEAR, month, day, hour, 0)
        for k in range(dur):
            gaps.add(ts_to_str(start + timedelta(minutes=k * INTERVAL_MIN)))
    return gaps


# ─────────────────────────────────────────────────────────────────────────────
# DDH table creation
# ─────────────────────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS turbine_performance (
    timestamp             TEXT    NOT NULL,
    turbine_id            TEXT    NOT NULL,
    active_power_kw       REAL,
    wind_speed_ms         REAL,
    wind_direction_deg    REAL,
    rotor_rpm             REAL,
    nacelle_direction_deg REAL,
    ambient_temp_c        REAL,
    air_density_kgm3      REAL,
    theoretical_power_kw  REAL,
    farm_id               TEXT,
    oem                   TEXT
);

CREATE TABLE IF NOT EXISTS availability_status (
    timestamp           TEXT    NOT NULL,
    turbine_id          TEXT    NOT NULL,
    status_code         INTEGER,
    iec_category        TEXT,
    is_available        INTEGER,
    downtime_minutes    REAL,
    lost_energy_kwh     REAL,
    loss_category       TEXT,
    work_order_id       TEXT
);

CREATE TABLE IF NOT EXISTS wind_resource (
    timestamp             TEXT    NOT NULL,
    source_type           TEXT,
    location_id           TEXT    NOT NULL,
    wind_speed_ms         REAL,
    wind_direction_deg    REAL,
    turbulence_intensity  REAL,
    shear_exponent        REAL,
    temperature_c         REAL,
    pressure_hpa          REAL
);

CREATE TABLE IF NOT EXISTS generation_production (
    date                     TEXT    NOT NULL,
    farm_id                  TEXT    NOT NULL,
    technology               TEXT,
    actual_generation_kwh    REAL,
    expected_generation_kwh  REAL,
    aep_target_kwh           REAL,
    curtailment_kwh          REAL,
    poi_export_kwh           REAL,
    poi_limit_kw             REAL,
    ppa_commitment_kwh       REAL
);

CREATE TABLE IF NOT EXISTS rpo_obligation (
    entity_name              TEXT    NOT NULL,
    state                    TEXT,
    year                     INTEGER,
    total_consumption_mwh    REAL,
    rpo_percentage           REAL,
    annual_obligation_mwh    REAL,
    other_re_procured_mwh    REAL,
    rec_purchased_mwh        REAL
);

CREATE TABLE IF NOT EXISTS solar_maintenance_event (
    event_id                  TEXT    NOT NULL,
    farm_id                   TEXT,
    maintenance_start         TEXT,
    maintenance_end           TEXT,
    active_alarm              INTEGER,
    inverter_temp_c           REAL,
    inverter_temp_spec_max_c  REAL,
    dust_level                TEXT,
    deferral_days_proposed    INTEGER,
    string_efficiency_pct     REAL,
    note                      TEXT
);
"""

IDX = """
CREATE INDEX IF NOT EXISTS idx_tp ON turbine_performance(turbine_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_as ON availability_status(turbine_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_wr ON wind_resource(location_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_gp ON generation_production(farm_id, date);
CREATE INDEX IF NOT EXISTS idx_sme ON solar_maintenance_event(event_id);
"""


def create_tables(conn):
    conn.executescript(DDL)
    conn.commit()


def create_indexes(conn):
    conn.executescript(IDX)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Turbine Performance + Availability/Status (wind — unchanged from original)
# ─────────────────────────────────────────────────────────────────────────────

def generate_turbine_tables(conn, timestamps, farm_wind_base, curtailment_sched,
                             t012_faults, t045_faults, stuck_windows, ts_gaps):
    n       = len(timestamps)
    ts_strs = [ts_to_str(t) for t in timestamps]
    months  = np.array([t.month for t in timestamps])

    temp_arr     = np.array([MONTHLY_TEMP[m]     for m in months], dtype=float)
    pressure_arr = np.array([MONTHLY_PRESSURE[m] for m in months], dtype=float)
    density_arr  = np.array([calc_density(temp_arr[i], pressure_arr[i]) for i in range(n)])
    base_dir_arr = np.array([MONTHLY_WIND_DIR[m] for m in months], dtype=float)
    dir_noise    = np.random.normal(0, 15, n)
    wind_dir_arr = (base_dir_arr + dir_noise) % 360.0

    maint_mask = {}
    for tid, (ws, we, wo) in MAINT_WINDOWS.items():
        maint_mask[tid] = {
            ts_to_str(ws + timedelta(minutes=k * INTERVAL_MIN)): wo
            for k in range(int((we - ws).total_seconds() // 60 // INTERVAL_MIN))
        }

    curt_grid_set = {s for s, t in curtailment_sched.items() if t == "grid"}
    curt_poi_set  = {s for s, t in curtailment_sched.items() if t == "poi"}
    curt_any_set  = curt_grid_set | curt_poi_set
    gap_set       = ts_gaps
    daily         = {}

    for tidx, tid in enumerate(TURBINE_IDS):
        print(f"  Generating turbine {tidx+1:2d}/{N_TURBINES}: {tid}", end="\r", flush=True)

        ind_noise = np.array([weibull_wind(1, MONTHLY_WIND_MEAN[m])[0] for m in months])
        ws        = np.clip(0.85 * farm_wind_base + 0.15 * ind_noise, 0.0, 35.0)

        yaw_deg    = YAW_ERRORS.get(tid, 0.0)
        yaw_factor = math.cos(math.radians(yaw_deg)) ** 3 if yaw_deg != 0.0 else 1.0

        deg_rate   = DEGRADATION.get(tid, 0.0)
        month_num  = np.array(months, dtype=float)
        deg_factor = np.clip(1.0 - deg_rate * (month_num - 1), 0.50, 1.0)

        p_theoretical = power_from_wind(ws, density_arr)
        p_theoretical = np.where(ws < CUT_IN, 0.0, p_theoretical)

        p_active = p_theoretical * yaw_factor * deg_factor
        p_active = p_active * np.random.normal(1.0, 0.02, n)
        p_active = np.clip(p_active, 0.0, RATED_KW * 1.02)

        rpm        = calc_rpm(ws)
        nacelle_dir = (wind_dir_arr + yaw_deg + np.random.normal(0, 1, n)) % 360.0

        status = np.zeros(n, dtype=int)
        wo_arr = np.full(n, None, dtype=object)

        status = np.where(ws < CUT_IN,  200, status)
        status = np.where(ws > CUT_OUT, 201, status)

        if tid == "T012":
            for i, s in enumerate(ts_strs):
                if s in t012_faults:
                    status[i] = 100

        if tid == PPA_RISK_TURBINE:
            for i, s in enumerate(ts_strs):
                if s in t045_faults and status[i] == 0:
                    status[i] = 300

        for i, s in enumerate(ts_strs):
            if s in curt_any_set and status[i] == 0:
                status[i] = 302

        if tid in maint_mask:
            mws = maint_mask[tid]
            for i, s in enumerate(ts_strs):
                if s in mws:
                    status[i] = 400
                    wo_arr[i]  = mws[s]

        if tid in MAINT_WINDOWS:
            _, we, wo = MAINT_WINDOWS[tid]
            inspection_start = we - timedelta(hours=4)
            for k in range(24):
                t = inspection_start + timedelta(minutes=k * INTERVAL_MIN)
                s = ts_to_str(t)
                for i2, ss in enumerate(ts_strs):
                    if ss == s:
                        status[i2] = 401
                        wo_arr[i2] = wo
                        break

        running_mask = (status == 0)
        p_active = np.where(running_mask, p_active, 0.0)
        rpm      = np.where(running_mask, rpm, 0.0)

        if tid == RPM_FLATLINE_TURBINE:
            flatline_indices = np.random.choice(
                np.where(p_active > 500)[0],
                size=min(20, int((p_active > 500).sum())),
                replace=False,
            )
            rpm[flatline_indices] = 0.0

        if tid in stuck_windows:
            stuck_map = {s: v for s, v in stuck_windows[tid]}
            for i, s in enumerate(ts_strs):
                if s in stuck_map:
                    ws[i] = stuck_map[s]

        if tid in OUTLIER_POWER_TURBINES:
            out_idx = np.random.choice(n, size=15, replace=False)
            p_active[out_idx] = np.random.choice([RATED_KW * 1.06, -55.0], size=15)

        df_tp = pd.DataFrame({
            "timestamp":             ts_strs,
            "turbine_id":            tid,
            "active_power_kw":       np.round(p_active, 2),
            "wind_speed_ms":         np.round(ws, 3),
            "wind_direction_deg":    np.round(wind_dir_arr, 1),
            "rotor_rpm":             np.round(rpm, 2),
            "nacelle_direction_deg": np.round(nacelle_dir, 1),
            "ambient_temp_c":        np.round(temp_arr, 1),
            "air_density_kgm3":      np.round(density_arr, 4),
            "theoretical_power_kw":  np.round(p_theoretical, 2),
            "farm_id":               FARM_WIND,
            "oem":                   OEM,
        })

        if tid == TIMESTAMP_GAP_TURBINE:
            df_tp = df_tp[~df_tp["timestamp"].isin(gap_set)].reset_index(drop=True)

        df_tp.to_sql("turbine_performance", conn, if_exists="append", index=False,
                     chunksize=5000)

        iec_cat  = [STATUS_MAP[c][0]             for c in status]
        is_avail = [1 if STATUS_MAP[c][1] else 0 for c in status]
        loss_cat = [STATUS_MAP[c][2]             for c in status]

        dt_min   = np.where(np.array(is_avail) == 0, float(INTERVAL_MIN), 0.0)
        lost_kwh = np.where(
            (np.array(is_avail) == 0) | (np.array(status) == 302),
            p_theoretical * (INTERVAL_MIN / 60.0),
            0.0,
        )

        def _filter(arr):
            return [arr[i] for i, s in enumerate(ts_strs) if s not in gap_set]

        if tid != TIMESTAMP_GAP_TURBINE:
            df_as = pd.DataFrame({
                "timestamp":        ts_strs,
                "turbine_id":       tid,
                "status_code":      status,
                "iec_category":     iec_cat,
                "is_available":     is_avail,
                "downtime_minutes": np.round(dt_min, 1),
                "lost_energy_kwh":  np.round(lost_kwh, 4),
                "loss_category":    loss_cat,
                "work_order_id":    wo_arr.tolist(),
            })
        else:
            df_as = pd.DataFrame({
                "timestamp":        df_tp["timestamp"].tolist(),
                "turbine_id":       tid,
                "status_code":      _filter(list(status)),
                "iec_category":     _filter(iec_cat),
                "is_available":     _filter(is_avail),
                "downtime_minutes": np.round(_filter(list(dt_min)), 1),
                "lost_energy_kwh":  np.round(_filter(list(lost_kwh)), 4),
                "loss_category":    _filter(loss_cat),
                "work_order_id":    _filter(wo_arr.tolist()),
            })

        df_as.to_sql("availability_status", conn, if_exists="append", index=False,
                     chunksize=5000)

        dates_arr = np.array([t.strftime("%Y-%m-%d") for t in timestamps])
        if tid != TIMESTAMP_GAP_TURBINE:
            act_kwh  = p_active      * (INTERVAL_MIN / 60.0)
            exp_kwh  = p_theoretical * (INTERVAL_MIN / 60.0)
            curt_kwh = np.where(np.isin(ts_strs, list(curt_any_set)), exp_kwh, 0.0)
        else:
            keep_mask = ~np.isin(ts_strs, list(gap_set))
            act_kwh   = p_active      * (INTERVAL_MIN / 60.0) * keep_mask
            exp_kwh   = p_theoretical * (INTERVAL_MIN / 60.0) * keep_mask
            curt_kwh  = np.where(keep_mask & np.isin(ts_strs, list(curt_any_set)), exp_kwh, 0.0)

        for d in np.unique(dates_arr):
            mask = dates_arr == d
            if d not in daily:
                daily[d] = [0.0, 0.0, 0.0]
            daily[d][0] += float(act_kwh[mask].sum())
            daily[d][1] += float(exp_kwh[mask].sum())
            daily[d][2] += float(curt_kwh[mask].sum())

    print(f"\n  Turbine tables complete ({N_TURBINES} turbines).")
    return daily


# ─────────────────────────────────────────────────────────────────────────────
# Wind Resource table (unchanged from original)
# ─────────────────────────────────────────────────────────────────────────────

def generate_wind_resource(conn, timestamps, farm_wind_base):
    print("  Generating wind_resource ...", end=" ", flush=True)
    n        = len(timestamps)
    ts_strs  = [ts_to_str(t) for t in timestamps]
    months   = [t.month for t in timestamps]
    base_dir = np.array([MONTHLY_WIND_DIR[m] for m in months], dtype=float)

    mm_ws  = np.clip(farm_wind_base + np.random.normal(0, 0.3, n), 0, 35)
    mm_dir = (base_dir + np.random.normal(0, 8, n)) % 360.0
    mm_ti  = np.clip(np.random.normal(0.15, 0.025, n), 0.08, 0.30)
    mm_sx  = np.full(n, 0.14)
    mm_temp = np.array([MONTHLY_TEMP[m] + np.random.normal(0, 2) for m in months])
    mm_prs  = np.array([MONTHLY_PRESSURE[m] + np.random.normal(0, 1.5) for m in months])

    df_mm = pd.DataFrame({
        "timestamp": ts_strs, "source_type": "met_mast", "location_id": "MM-GJ01",
        "wind_speed_ms": np.round(mm_ws, 3), "wind_direction_deg": np.round(mm_dir, 1),
        "turbulence_intensity": np.round(mm_ti, 4), "shear_exponent": mm_sx,
        "temperature_c": np.round(mm_temp, 1), "pressure_hpa": np.round(mm_prs, 1),
    })
    df_mm.to_sql("wind_resource", conn, if_exists="append", index=False,
                 chunksize=5000)

    for tnum in range(1, 11):
        tid  = f"T{tnum:03d}"
        t_ws = np.clip(farm_wind_base + np.random.normal(0, 0.5, n), 0, 35)
        t_dir = (base_dir + np.random.normal(0, 12, n)) % 360.0
        t_ti  = np.clip(np.random.normal(0.17, 0.03, n), 0.08, 0.35)
        df_t = pd.DataFrame({
            "timestamp": ts_strs, "source_type": "scada", "location_id": tid,
            "wind_speed_ms": np.round(t_ws, 3), "wind_direction_deg": np.round(t_dir, 1),
            "turbulence_intensity": np.round(t_ti, 4), "shear_exponent": np.full(n, 0.14),
            "temperature_c": np.round(mm_temp, 1), "pressure_hpa": np.round(mm_prs, 1),
        })
        df_t.to_sql("wind_resource", conn, if_exists="append", index=False,
                    chunksize=5000)

    print("done.")


# ─────────────────────────────────────────────────────────────────────────────
# Generation Production table — solar side uses irradiance model
# ─────────────────────────────────────────────────────────────────────────────

def generate_generation_production(conn, daily_wind, solar_daily,
                                   curtailment_sched, timestamps):
    print("  Generating generation_production ...", end=" ", flush=True)

    daily_aep_wind  = AEP_WIND_KWH  / 365.0
    daily_aep_solar = AEP_SOLAR_KWH / 365.0
    daily_ppa_wind  = PPA_WIND_KWH  / 365.0
    daily_ppa_solar = PPA_SOLAR_KWH / 365.0

    curt_poi_dates = set(s[:10] for s, t in curtailment_sched.items() if t == "poi")
    all_dates      = sorted({t.strftime("%Y-%m-%d") for t in timestamps})
    rows           = []

    for d_str in all_dates:
        d     = datetime.strptime(d_str, "%Y-%m-%d")
        month = d.month

        # ── Wind row (unchanged logic) ─────────────────────────────────────
        w_act, w_exp, w_curt = daily_wind.get(d_str, [0.0, 0.0, 0.0])

        # ── Solar row — irradiance-model based ────────────────────────────
        sol_data = solar_daily.get(d_str, {"s_clearsky": 0.0})
        s_clearsky = sol_data["s_clearsky"]   # kWh: clear-sky (pvlib) or GHI-table baseline

        if _PVLIB_AVAILABLE:
            # pvlib path: actual = clear-sky × monthly cloud derate × daily variability
            cloud_derate = MONTHLY_CLOUD_DERATE[month]
            s_exp = s_clearsky                                  # expected = clear-sky
            s_act = s_clearsky * cloud_derate * np.random.uniform(0.95, 1.05)
        else:
            # Fallback path: GHI table already includes cloud effects;
            # expected = GHI-based baseline, actual = expected × daily variability
            s_exp = s_clearsky
            s_act = s_clearsky * np.random.uniform(0.95, 1.05)

        s_act  = max(0.0, s_act)
        s_curt = 0.0

        # ── Hybrid POI curtailment (A7) ───────────────────────────────────
        if d_str in curt_poi_dates:
            POI_EXCESS_KW    = 30_000.0
            EVENT_DURATION_H = 2.5
            poi_curt_total   = POI_EXCESS_KW * EVENT_DURATION_H
            wind_cap  = 200_000.0
            solar_cap = SOLAR_AC_KW
            w_share   = wind_cap  / (wind_cap + solar_cap)
            s_share   = solar_cap / (wind_cap + solar_cap)
            w_curt   += poi_curt_total * w_share
            s_curt   += poi_curt_total * s_share

        s_act = max(0.0, s_act - s_curt) * np.random.uniform(0.97, 1.01)

        poi_export_kwh = min(w_act + s_act, POI_LIMIT_KW * 24.0)

        rows.append({
            "date": d_str, "farm_id": FARM_WIND, "technology": "wind",
            "actual_generation_kwh":   round(w_act,  2),
            "expected_generation_kwh": round(w_exp,  2),
            "aep_target_kwh":          round(daily_aep_wind,  2),
            "curtailment_kwh":         round(max(w_curt, 0.0), 2),
            "poi_export_kwh":          round(poi_export_kwh * w_act / max(w_act + s_act, 1), 2),
            "poi_limit_kw":            POI_LIMIT_KW,
            "ppa_commitment_kwh":      round(daily_ppa_wind, 2),
        })
        rows.append({
            "date": d_str, "farm_id": FARM_SOLAR, "technology": "solar",
            "actual_generation_kwh":   round(s_act, 2),
            "expected_generation_kwh": round(s_exp, 2),
            "aep_target_kwh":          round(daily_aep_solar, 2),
            "curtailment_kwh":         round(max(s_curt, 0.0), 2),
            "poi_export_kwh":          round(poi_export_kwh * s_act / max(w_act + s_act, 1), 2),
            "poi_limit_kw":            POI_LIMIT_KW,
            "ppa_commitment_kwh":      round(daily_ppa_solar, 2),
        })

    df = pd.DataFrame(rows)
    df.to_sql("generation_production", conn, if_exists="append", index=False,
              chunksize=1000)
    print("done.")


# ─────────────────────────────────────────────────────────────────────────────
# RPO Obligation + Solar Maintenance Events (A11, A12)
# ─────────────────────────────────────────────────────────────────────────────

def generate_rpo_obligation(conn):
    print("  Generating rpo_obligation ...", end=" ", flush=True)
    df = pd.DataFrame([{
        "entity_name":           RPO_ENTITY,
        "state":                 RPO_STATE,
        "year":                  SIM_YEAR,
        "total_consumption_mwh": RPO_TOTAL_CONSUMPTION_MWH,
        "rpo_percentage":        RPO_PERCENTAGE,
        "annual_obligation_mwh": round(RPO_ANNUAL_OBLIGATION_MWH, 2),
        "other_re_procured_mwh": RPO_OTHER_RE_MWH,
        "rec_purchased_mwh":     RPO_REC_PURCHASED_MWH,
    }])
    df.to_sql("rpo_obligation", conn, if_exists="append", index=False)
    print("done.")


def generate_solar_maintenance_events(conn):
    print("  Generating solar_maintenance_event ...", end=" ", flush=True)
    rows = []
    for event_id, month, day, alarm, temp, dust, note in SOLAR_MAINTENANCE_EVENTS:
        start = datetime(SIM_YEAR, month, day, 8, 0)
        end   = start + timedelta(days=SOLAR_MAINT_DEFERRAL_DAYS)
        rows.append({
            "event_id":                 event_id,
            "farm_id":                  FARM_SOLAR,
            "maintenance_start":        ts_to_str(start),
            "maintenance_end":          ts_to_str(end),
            "active_alarm":             alarm,
            "inverter_temp_c":          temp,
            "inverter_temp_spec_max_c": OEM_INVERTER_TEMP_MAX_C,
            "dust_level":               dust,
            "deferral_days_proposed":   SOLAR_MAINT_DEFERRAL_DAYS,
            "string_efficiency_pct":    SOLAR_MAINT_STRING_EFF_PCT,
            "note":                     note,
        })
    df = pd.DataFrame(rows)
    df.to_sql("solar_maintenance_event", conn, if_exists="append", index=False)
    print("done.")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    print("Kagent corrected sample DB generator")
    print(f"Output  : {DB_PATH}")
    print(f"Period  : {START_DT.date()} → {END_DT.date()}")
    print(f"Farm    : {N_TURBINES} wind turbines ({FARM_WIND}) + solar ({FARM_SOLAR})")
    print(f"Solar   : {SOLAR_DC_KW/1000:.0f} MW DC / {SOLAR_AC_KW/1000:.0f} MW AC  "
          f"target CUF {SOLAR_TARGET_CUF*100:.0f}%  AEP {AEP_SOLAR_KWH/1e6:.1f} GWh")
    print(f"PPA     : {PPA_CONTRACTED_KW/1000:.0f} MW contracted  "
          f"commitment {PPA_SOLAR_KWH/1e6:.1f} GWh/yr")
    print()

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA cache_size=-64000")

    print("[1/9] Creating tables ...")
    create_tables(conn)

    print("[2/9] Building timestamps and farm wind base ...")
    timestamps     = build_timestamps()
    farm_wind_base = build_farm_wind_base(timestamps)
    print(f"      {len(timestamps):,} intervals ({len(timestamps) * N_TURBINES:,} turbine-rows expected)")

    print("[3/9] Building solar generation (irradiance model) ...")
    solar_daily = build_solar_generation(SIM_YEAR)
    annual_solar_kwh = sum(v["s_clearsky"] for v in solar_daily.values())
    solar_cuf = annual_solar_kwh / (SOLAR_DC_KW * CERC_HOURS) * 100
    print(f"      Baseline annual solar : {annual_solar_kwh/1e6:.1f} GWh  "
          f"(CUF {solar_cuf:.1f} % on DC basis, CERC 8,766 h convention)")

    print("[4/9] Building event schedules ...")
    curtailment_sched = build_curtailment_schedule(timestamps)
    t012_faults       = build_t012_faults()
    t045_faults       = build_t045_faults()
    stuck_windows     = build_stuck_sensor_windows()
    ts_gaps           = build_timestamp_gaps()
    print(f"      Curtailment days   : {len(set(s[:10] for s in curtailment_sched))} days affected")
    print(f"      T012 fault windows : {len(t012_faults)} intervals")
    print(f"      T045 fault windows : {len(t045_faults)} intervals")

    print("[5/9] Generating turbine_performance + availability_status ...")
    daily_wind = generate_turbine_tables(
        conn, timestamps, farm_wind_base, curtailment_sched,
        t012_faults, t045_faults, stuck_windows, ts_gaps,
    )

    print("[6/9] Generating wind_resource ...")
    generate_wind_resource(conn, timestamps, farm_wind_base)

    print("[7/9] Generating generation_production ...")
    generate_generation_production(conn, daily_wind, solar_daily, curtailment_sched, timestamps)

    print("[8/9] Generating rpo_obligation ...")
    generate_rpo_obligation(conn)

    print("[9/9] Generating solar_maintenance_event ...")
    generate_solar_maintenance_events(conn)

    print("\nBuilding indexes ...")
    create_indexes(conn)
    conn.close()

    size_mb = os.path.getsize(DB_PATH) / 1_048_576
    print(f"\nDone.  Database : {DB_PATH}  ({size_mb:.1f} MB)")

    conn2 = sqlite3.connect(DB_PATH)
    for tbl in ["turbine_performance", "availability_status", "wind_resource", "generation_production",
                "rpo_obligation", "solar_maintenance_event"]:
        (cnt,) = conn2.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()
        print(f"  {tbl:<30s} {cnt:>10,} rows")
    (solar_actual_kwh,) = conn2.execute(
        "SELECT SUM(actual_generation_kwh) FROM generation_production WHERE technology='solar'"
    ).fetchone()
    actual_cuf = (solar_actual_kwh or 0) / (SOLAR_DC_KW * CERC_HOURS) * 100
    print(f"\n  Actual solar CUF (with cloud derates + variability): {actual_cuf:.1f} %")
    conn2.close()


if __name__ == "__main__":
    main()
