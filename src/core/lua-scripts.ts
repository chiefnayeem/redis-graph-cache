/**
 * Atomic Lua scripts for race-free Redis operations.
 *
 * Each script is registered on the ioredis client via `defineCommand` and
 * exposed as a typed method (see redis-connection-manager.ts).
 *
 * Why Lua: Redis executes a Lua script as a single atomic unit, so we get
 * compare-and-set, conditional writes, and array mutations without
 * client-side races, WATCH/MULTI overhead, or extra round-trips.
 */

/**
 * Compare-and-set. Writes `newValue` only if the current value at `key`
 * exactly equals `expectedValue`. Empty-string `expectedValue` means
 * "expect key to not exist".
 *
 * KEYS[1] = entity key
 * ARGV[1] = expected current value (or "" to expect absence)
 * ARGV[2] = new value
 * ARGV[3] = ttl seconds (0 or negative = no expiry)
 *
 * Returns: 1 on success, 0 on conflict.
 */
export const CAS_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if expected == "" then
  if current then return 0 end
else
  if current ~= expected then return 0 end
end
local ttl = tonumber(ARGV[3])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1
`;

/**
 * Set the value only if the key already exists. Used for "update only if
 * cached" semantics so we don't accidentally warm the cache for unread data.
 *
 * KEYS[1] = entity key
 * ARGV[1] = new value
 * ARGV[2] = ttl seconds (0 or negative = no expiry)
 *
 * Returns: 1 on success, 0 if key did not exist.
 */
export const SET_IF_EXISTS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
`;

/**
 * Atomically add an id to a JSON-array list value. Idempotent: if the id is
 * already present, no write happens and 0 is returned. The list value is
 * stored as a JSON array string (e.g. "[1,2,3]"). When the key is missing,
 * a new single-element array is created.
 *
 * Note: cjson.encode of an empty Lua table yields "{}" rather than "[]".
 * We never encode an empty list here because we always insert exactly one
 * element, so this is safe.
 *
 * KEYS[1] = list key
 * ARGV[1] = id (always passed as string; numeric ids are stringified by the
 *           caller and re-parsed when read)
 * ARGV[2] = ttl seconds (0 or negative = no expiry)
 * ARGV[3] = "1" if id should be coerced back to number when stored, else "0"
 *
 * Returns: 1 if added, 0 if already present.
 */
export const LIST_ADD_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local ids
if current then
  ids = cjson.decode(current)
  if type(ids) ~= 'table' then ids = {} end
else
  ids = {}
end
local needle = ARGV[1]
for i = 1, #ids do
  if tostring(ids[i]) == needle then return 0 end
end
local toInsert
if ARGV[3] == "1" then
  toInsert = tonumber(needle)
  if toInsert == nil then toInsert = needle end
else
  toInsert = needle
end
table.insert(ids, toInsert)
local encoded = cjson.encode(ids)
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return 1
`;

/**
 * Atomically remove an id from a JSON-array list value. If the resulting
 * list is empty, writes the literal "[]" (avoiding cjson's {} ambiguity).
 *
 * KEYS[1] = list key
 * ARGV[1] = id (always passed as string)
 *
 * Returns: 1 if removed, 0 if list missing or id not found.
 */
export const LIST_REMOVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ids = cjson.decode(current)
if type(ids) ~= 'table' then return 0 end
local needle = ARGV[1]
local found = false
local out = {}
for i = 1, #ids do
  if tostring(ids[i]) == needle and not found then
    found = true
  else
    table.insert(out, ids[i])
  end
end
if not found then return 0 end
local encoded
if #out == 0 then
  encoded = '[]'
else
  encoded = cjson.encode(out)
end
local ttl = redis.call('TTL', KEYS[1])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return 1
`;

/**
 * Atomic ZADD into a sorted set, with optional max-size trim and optional
 * back-index update for cascade invalidation. Returns 1 if a new member
 * was added, 0 if the score was updated on an existing member.
 *
 * Trimming uses ZREMRANGEBYRANK to discard the lowest-scored members so
 * that exactly `maxSize` items remain. This works correctly whether the
 * list is being read newest-first (ZREVRANGE) or oldest-first (ZRANGE):
 * the lowest score is always the "oldest" by whatever score axis is in
 * use.
 *
 * KEYS[1] = ZSET list key
 * KEYS[2] = membership back-index key (ignored when ARGV[5] = "0")
 * ARGV[1] = numeric score (passed as string; Redis parses)
 * ARGV[2] = member id (always passed as string)
 * ARGV[3] = ttl seconds (0 = no expiry refresh)
 * ARGV[4] = max size (0 = no trim)
 * ARGV[5] = "1" to maintain back-index, "0" otherwise
 */
export const ZLIST_ADD_SCRIPT = `
local added = redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
if ARGV[5] == "1" then
  redis.call('SADD', KEYS[2], KEYS[1])
end
local maxSize = tonumber(ARGV[4])
if maxSize and maxSize > 0 then
  local size = redis.call('ZCARD', KEYS[1])
  if size > maxSize then
    redis.call('ZREMRANGEBYRANK', KEYS[1], 0, size - maxSize - 1)
  end
end
local ttl = tonumber(ARGV[3])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  if ARGV[5] == "1" then
    -- Back-index TTL is set to a generous multiple of the list TTL so the
    -- index outlives any one list TTL refresh. Without this it could
    -- expire while the list still references it, leaving cascade
    -- invalidation unable to find tracked lists. 4x is empirically safe.
    redis.call('EXPIRE', KEYS[2], ttl * 4)
  end
end
return added
`;

/**
 * Atomic ZREM with optional back-index cleanup. Returns 1 if removed, 0
 * if the member was not in the set.
 *
 * KEYS[1] = ZSET list key
 * KEYS[2] = membership back-index key (ignored when ARGV[2] = "0")
 * ARGV[1] = member id
 * ARGV[2] = "1" to maintain back-index, "0" otherwise
 *
 * Note: we don't SREM the list key from the back-index here because we
 * only know that *this* id was removed; other ids in the same list may
 * still reference it. The back-index entry is per-id, and the SADD/SREM
 * pairing is balanced across `addIndexedListItem` and the cascade path.
 */
export const ZLIST_REMOVE_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
if removed > 0 and ARGV[2] == "1" then
  -- Membership entries are id-scoped: if THIS id has no other tracked
  -- lists pointing at it (i.e. we're the last reference), the back-index
  -- still keeps the listKey -> see comment above. We intentionally leave
  -- the back-index alone here; cascade invalidation cleans it up.
end
return removed
`;

/**
 * Cascade-invalidate: read every list key from the back-index for an
 * entity, ZREM the entity from each, then delete the entity key itself
 * and the back-index. All atomic in one round-trip.
 *
 * KEYS[1] = membership back-index key (e.g. __rse_membership:post:42)
 * KEYS[2] = entity key (e.g. post:42)
 * ARGV[1] = member id (string form, used for ZREM)
 *
 * Returns: number of lists the entity was removed from.
 *
 * Robustness: if any list key has already been deleted (TTL expired,
 * manually removed, etc.) ZREM is a no-op for that key, which is the
 * desired behaviour.
 */
export const CASCADE_INVALIDATE_SCRIPT = `
local lists = redis.call('SMEMBERS', KEYS[1])
local removed = 0
for i = 1, #lists do
  local r = redis.call('ZREM', lists[i], ARGV[1])
  if r > 0 then removed = removed + 1 end
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return removed
`;

/**
 * Names used when registering scripts with ioredis.defineCommand.
 * These become methods on the redis client instance with the same name.
 */
export const SCRIPT_DEFINITIONS = [
  { name: 'rseCasSet', script: CAS_SET_SCRIPT, numberOfKeys: 1 },
  { name: 'rseSetIfExists', script: SET_IF_EXISTS_SCRIPT, numberOfKeys: 1 },
  { name: 'rseListAdd', script: LIST_ADD_SCRIPT, numberOfKeys: 1 },
  { name: 'rseListRemove', script: LIST_REMOVE_SCRIPT, numberOfKeys: 1 },
  { name: 'rseZListAdd', script: ZLIST_ADD_SCRIPT, numberOfKeys: 2 },
  { name: 'rseZListRemove', script: ZLIST_REMOVE_SCRIPT, numberOfKeys: 2 },
  {
    name: 'rseCascadeInvalidate',
    script: CASCADE_INVALIDATE_SCRIPT,
    numberOfKeys: 2,
  },
] as const;

export type ScriptName = (typeof SCRIPT_DEFINITIONS)[number]['name'];
