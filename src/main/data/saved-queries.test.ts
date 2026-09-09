import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from '../db'
import { deleteSavedQuery, getSavedQuery, listSavedQueries, saveSavedQuery } from './saved-queries'

describe('saved queries', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('starts with no saved queries', () => {
    expect(listSavedQueries()).toEqual([])
  })

  it('saves a parametric query and computes mutates=false for a read', () => {
    const saved = saveSavedQuery({
      connectionId: 'conn-1',
      name: 'orders_by_status',
      description: 'Orders with a given status',
      sql: 'SELECT * FROM orders WHERE status = :status',
      params: [{ name: 'status', type: 'string' }]
    })
    expect(saved).toMatchObject({ name: 'orders_by_status', mutates: false })
    expect(listSavedQueries()).toEqual([saved])
  })

  it('computes mutates=true for a write query', () => {
    const saved = saveSavedQuery({
      connectionId: 'conn-1',
      name: 'archive_order',
      description: 'Marks an order archived',
      sql: 'UPDATE orders SET archived = 1 WHERE id = :id',
      params: [{ name: 'id', type: 'number' }]
    })
    expect(saved.mutates).toBe(true)
  })

  it('rejects a query whose SQL references an undeclared placeholder', () => {
    expect(() =>
      saveSavedQuery({
        connectionId: 'conn-1',
        name: 'bad',
        description: '',
        sql: 'SELECT * FROM orders WHERE status = :status',
        params: []
      })
    ).toThrow(/:status/)
  })

  it('filters by connectionId', () => {
    saveSavedQuery({ connectionId: 'a', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    saveSavedQuery({ connectionId: 'b', name: 'q2', description: '', sql: 'SELECT 1', params: [] })
    expect(listSavedQueries('a')).toHaveLength(1)
    expect(listSavedQueries('a')[0].name).toBe('q1')
  })

  it('gets a single saved query by id, or undefined if unknown', () => {
    const saved = saveSavedQuery({ connectionId: 'a', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    expect(getSavedQuery(saved.id)).toEqual(saved)
    expect(getSavedQuery('nope')).toBeUndefined()
  })

  it('editing a saved query in place keeps its id and replaces the rest', () => {
    const saved = saveSavedQuery({ connectionId: 'a', name: 'q1', description: 'old', sql: 'SELECT 1', params: [] })
    const edited = saveSavedQuery({ id: saved.id, connectionId: 'a', name: 'q1', description: 'new', sql: 'SELECT 2', params: [] })
    expect(edited.id).toBe(saved.id)
    expect(listSavedQueries()).toEqual([edited])
  })

  it('deletes a saved query', () => {
    const saved = saveSavedQuery({ connectionId: 'a', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    deleteSavedQuery(saved.id)
    expect(listSavedQueries()).toEqual([])
  })
})
