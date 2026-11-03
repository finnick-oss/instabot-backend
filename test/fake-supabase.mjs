// Minimal in-memory stand-in for the subset of supabase-js the server uses.
// Mirrors the real schema's primary keys, the interactions unique key and ON DELETE CASCADE.

const PRIMARY_KEYS = {
  accounts: ['ig_account_id'],
  sessions: ['token_hash'],
  oauth_states: ['state'],
  automations: ['id'],
  interactions: ['id'],
  config: ['id'],
}
const UNIQUE_KEYS = { interactions: [['ig_account_id', 'comment_id']] }
const CASCADES = { accounts: [['sessions', 'ig_account_id'], ['automations', 'ig_account_id'], ['interactions', 'ig_account_id']] }

export function createFakeSupabase(seed = {}) {
  const tables = {}
  // Real time, but strictly increasing so ordering by created_at is deterministic
  let last = 0
  let serial = 0
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString()

  const rowsOf = (t) => (tables[t] ||= [])
  for (const [t, rows] of Object.entries(seed)) rowsOf(t).push(...rows.map(r => ({ ...r })))

  const sameKey = (cols, a, b) => cols.every(c => a[c] === b[c] && a[c] !== undefined && a[c] !== null)

  function withDefaults(table, row) {
    const r = { ...row }
    if (table === 'interactions' && r.id === undefined) r.id = ++serial
    if (['accounts', 'sessions', 'oauth_states', 'automations', 'interactions'].includes(table)) {
      r.created_at ||= now()
    }
    if (table === 'accounts') r.connected_at ||= r.created_at
    return r
  }

  function violatesUnique(table, row, ignore) {
    for (const cols of [PRIMARY_KEYS[table], ...(UNIQUE_KEYS[table] || [])]) {
      if (cols && rowsOf(table).some(r => r !== ignore && sameKey(cols, r, row))) return true
    }
    return false
  }

  function cascadeDelete(table, removed) {
    for (const [child, col] of CASCADES[table] || []) {
      const pk = PRIMARY_KEYS[table][0]
      const ids = new Set(removed.map(r => r[pk]))
      const gone = rowsOf(child).filter(r => ids.has(r[col]))
      tables[child] = rowsOf(child).filter(r => !ids.has(r[col]))
      cascadeDelete(child, gone)
    }
  }

  function query(table) {
    const state = { op: 'select', filters: [], orderBy: null, limit: null, single: null, returning: false, count: null, head: false }
    const api = {
      select(cols, opts = {}) {
        if (state.op === 'select') { state.count = opts.count || null; state.head = !!opts.head } else state.returning = true
        return api
      },
      insert(values) { state.op = 'insert'; state.values = [].concat(values); return api },
      upsert(values) { state.op = 'upsert'; state.values = [].concat(values); return api },
      update(values) { state.op = 'update'; state.values = values; return api },
      delete() { state.op = 'delete'; return api },
      eq(col, val) { state.filters.push(r => r[col] === val); return api },
      lt(col, val) { state.filters.push(r => r[col] < val); return api },
      order(col, { ascending = true } = {}) { state.orderBy = { col, ascending }; return api },
      limit(n) { state.limit = n; return api },
      maybeSingle() { state.single = 'maybe'; return api },
      single() { state.single = 'one'; return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }

    const matches = () => rowsOf(table).filter(r => state.filters.every(f => f(r)))

    function shape(rows) {
      if (state.single === 'maybe') {
        if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } }
        return { data: rows[0] ? { ...rows[0] } : null, error: null }
      }
      if (state.single === 'one') {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'expected one row' } }
        return { data: { ...rows[0] }, error: null }
      }
      return { data: rows.map(r => ({ ...r })), error: null }
    }

    function run() {
      if (state.op === 'select') {
        let rows = matches()
        if (state.orderBy) {
          const { col, ascending } = state.orderBy
          rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending ? 1 : -1))
        }
        if (state.limit !== null) rows = rows.slice(0, state.limit)
        if (state.head) return { data: null, count: rows.length, error: null }
        return { ...shape(rows), count: state.count ? rows.length : null }
      }
      if (state.op === 'insert') {
        const inserted = []
        for (const v of state.values) {
          const row = withDefaults(table, v)
          if (violatesUnique(table, row)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          rowsOf(table).push(row)
          inserted.push(row)
        }
        return state.returning ? shape(inserted) : { data: null, error: null }
      }
      if (state.op === 'upsert') {
        const pk = PRIMARY_KEYS[table]
        for (const v of state.values) {
          const existing = rowsOf(table).find(r => sameKey(pk, r, v))
          if (existing) Object.assign(existing, v)
          else rowsOf(table).push(withDefaults(table, v))
        }
        return { data: null, error: null }
      }
      if (state.op === 'update') {
        for (const r of matches()) Object.assign(r, state.values)
        return { data: null, error: null }
      }
      if (state.op === 'delete') {
        const removed = matches()
        tables[table] = rowsOf(table).filter(r => !removed.includes(r))
        cascadeDelete(table, removed)
        return { data: null, error: null }
      }
    }
    return api
  }

  return { from: query, tables, rows: rowsOf }
}
