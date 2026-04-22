/**
 * Priority queue — generic min-heap with stable tiebreak.
 *
 * Used by schedule-driven primitives that need O(log n) "pop the
 * next due item":
 *
 *   - Reminder-planner: next reminder to fire.
 *   - Agent-review TTL expiry: earliest-expiring entry.
 *   - Briefing-schedule composition.
 *
 * **Min-heap semantics** — `pop()` returns the item with the smallest
 * priority. Callers that want max-heap semantics just negate their
 * priorities (or supply an inverted comparator).
 *
 * **Stable tiebreak** — when two items have equal priority, FIFO on
 * insertion order (earlier items pop first). Implemented via an
 * internal monotonic sequence counter so heap comparisons are strict.
 *
 * **Optional custom comparator** — pass `{compare}` to override the
 * natural ordering. The default expects `number` priorities.
 *
 * **Operations**:
 *
 *   push(priority, value)      → O(log n)
 *   pop()                       → O(log n), returns {priority, value} | null
 *   peek()                      → O(1)
 *   remove(predicate)           → O(n), returns removed count
 *   size() / isEmpty() / clear() / snapshot()
 */

export interface HeapEntry<TValue, TPriority = number> {
  priority: TPriority;
  value: TValue;
}

export interface PriorityQueueOptions<TPriority> {
  /**
   * Custom priority comparator. Returns negative if `a < b`, positive
   * if `a > b`, zero for equal. Default compares as `number`.
   */
  compare?: (a: TPriority, b: TPriority) => number;
}

interface InternalEntry<TValue, TPriority> {
  priority: TPriority;
  value: TValue;
  /** Monotonic sequence for stable FIFO tiebreak. */
  seq: number;
}

const defaultNumericCompare = (a: number, b: number): number => a - b;

export class PriorityQueue<TValue, TPriority = number> {
  private readonly data: Array<InternalEntry<TValue, TPriority>> = [];
  private readonly compareFn: (a: TPriority, b: TPriority) => number;
  private counter = 0;

  constructor(opts: PriorityQueueOptions<TPriority> = {}) {
    this.compareFn = opts.compare ?? (defaultNumericCompare as unknown as (a: TPriority, b: TPriority) => number);
  }

  size(): number {
    return this.data.length;
  }

  isEmpty(): boolean {
    return this.data.length === 0;
  }

  /** Add an item. */
  push(priority: TPriority, value: TValue): void {
    this.data.push({ priority, value, seq: this.counter++ });
    this.siftUp(this.data.length - 1);
  }

  /** Remove and return the min-priority item. `null` when empty. */
  pop(): HeapEntry<TValue, TPriority> | null {
    if (this.data.length === 0) return null;
    const top = this.data[0]!;
    const tail = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = tail;
      this.siftDown(0);
    }
    return { priority: top.priority, value: top.value };
  }

  /** Peek the min-priority item without removing. */
  peek(): HeapEntry<TValue, TPriority> | null {
    const top = this.data[0];
    return top ? { priority: top.priority, value: top.value } : null;
  }

  /**
   * Remove every entry matching `predicate`. Returns the count
   * removed. O(n) — the heap is rebuilt once after removal.
   */
  remove(predicate: (value: TValue, priority: TPriority) => boolean): number {
    const keep: InternalEntry<TValue, TPriority>[] = [];
    let removed = 0;
    for (const entry of this.data) {
      if (predicate(entry.value, entry.priority)) {
        removed += 1;
      } else {
        keep.push(entry);
      }
    }
    if (removed === 0) return 0;
    this.data.length = 0;
    for (const e of keep) this.data.push(e);
    // Rebuild heap property over the retained entries.
    for (let i = Math.floor(this.data.length / 2) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
    return removed;
  }

  /** Return ordered snapshot (pop order) without mutating the heap. */
  snapshot(): HeapEntry<TValue, TPriority>[] {
    const copy: InternalEntry<TValue, TPriority>[] = [...this.data];
    const out: HeapEntry<TValue, TPriority>[] = [];
    // Repeatedly extract min without mutating `this.data`.
    while (copy.length > 0) {
      const top = copy[0]!;
      const tail = copy.pop()!;
      if (copy.length > 0) {
        copy[0] = tail;
        this.siftDownInArray(copy, 0);
      }
      out.push({ priority: top.priority, value: top.value });
    }
    return out;
  }

  clear(): void {
    this.data.length = 0;
    this.counter = 0;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private cmp(
    a: InternalEntry<TValue, TPriority>,
    b: InternalEntry<TValue, TPriority>,
  ): number {
    const p = this.compareFn(a.priority, b.priority);
    if (p !== 0) return p;
    return a.seq - b.seq;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.data[i]!, this.data[parent]!) >= 0) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.cmp(this.data[l]!, this.data[smallest]!) < 0) smallest = l;
      if (r < n && this.cmp(this.data[r]!, this.data[smallest]!) < 0) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private siftDownInArray(
    arr: InternalEntry<TValue, TPriority>[],
    i: number,
  ): void {
    const n = arr.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.cmp(arr[l]!, arr[smallest]!) < 0) smallest = l;
      if (r < n && this.cmp(arr[r]!, arr[smallest]!) < 0) smallest = r;
      if (smallest === i) break;
      [arr[i], arr[smallest]] = [arr[smallest]!, arr[i]!];
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const t = this.data[i]!;
    this.data[i] = this.data[j]!;
    this.data[j] = t;
  }
}
