# Null and Undefined Handling

A short, accurate description of how the cache treats missing, `null`, and
`undefined` values during writes and reads. There are real edge cases here
and getting them wrong silently corrupts cache.

---

## TL;DR

| Input value | What gets stored | What gets read back |
|---|---|---|
| `null` | `null` | `null` |
| `undefined` (explicit) | **field is omitted entirely** | field is `undefined` (not present) |
| Field omitted from input | not written; existing value preserved by smart-merge | unchanged |
| Explicit `null` overwriting an existing value | `null` | `null` |

The previous version of this doc claimed `undefined` was "stored as `null`".
That is **incorrect**. `JSON.stringify` drops `undefined`-valued keys
entirely, so the field is not present in the stored payload. On read the
key simply does not appear on the returned object.

---

## How writes process fields

The normalization engine copies a field from input to the normalized entity
only when `fieldName in data` is true:

```ts
if (schema.fields) {
  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (fieldName in data) {
      normalizedEntity[fieldName] = data[fieldName];
    }
  }
}
```

So a field is included in the write iff the caller's object literally has
that property. Whether the property's value is `undefined`, `null`,
`'foo'`, or `0` doesn't matter at this point. The relevant difference
appears at `JSON.stringify` time, which **drops** `undefined`-valued keys
from the resulting JSON string.

---

## Smart merge preserves missing fields

When you write a partial update, the cache reads the current cached value,
merges your new fields on top, and writes the result back atomically (via
the CAS-with-retry path). Fields you didn't include remain untouched.

```ts
// Initial write
await cache.writeEntity('post', {
  id: 1,
  title: 'Original',
  content: 'Long body...',
  views: 100,
});

// Partial update: only title
await cache.writeEntity('post', { id: 1, title: 'Updated' });

// Read back
await cache.readEntity('post', 1);
// → { id: 1, title: 'Updated', content: 'Long body...', views: 100 }
```

This is true for nested relations too: an update that re-writes only the
`category` relation does not touch `comments` or `author`.

---

## Explicit `null` is a real overwrite

If you want to clear a field, set it to `null`. That stores `null` and
overwrites whatever was there.

```ts
await cache.writeEntity('post', { id: 1, publishedAt: '2025-01-01' });
await cache.writeEntity('post', { id: 1, publishedAt: null });
await cache.readEntity('post', 1);
// → { id: 1, publishedAt: null, ... }
```

---

## `undefined` is identical to "field omitted"

Because `JSON.stringify({ a: undefined })` is `'{}'`, an explicit
`undefined` value is the same as not including the key at all. Both end up
preserved-by-merge — neither clears the existing value.

```ts
// These two writes are equivalent.
await cache.writeEntity('post', { id: 1, content: undefined });
await cache.writeEntity('post', { id: 1 });
```

If you actually want to clear a field, pass `null`, not `undefined`.

---

## Recommendations

1. **Use `null` to mean "no value"** in domain models. It round-trips
   exactly and is unambiguous.
2. **Omit fields you aren't updating.** Smart merge preserves them.
3. **Don't rely on `undefined` to clear a field.** It won't — use `null`.
4. **Don't rely on a field's absence in the read result implying `null`.**
   The field will be `undefined` (truly absent), not `null`.

---

## Smart-merge type rules (for reference)

The merge path applies the following rules per field, in order:

| Field type | Merge behaviour |
|---|---|
| Internal `__rse_*` | Always overwritten with new value |
| `null` / primitive (string, number, boolean) | Replace with new value |
| Array | Replace entire array (no element-wise merging) |
| Plain object | Deep-merge, preserving keys not present in the new object |

Arrays are intentionally not deep-merged because cache callers usually
want array replacement semantics for relation lists, not pairwise merging
of array elements (which has no canonical definition anyway).
