/**
 * LRU Cache with O(1) eviction using doubly-linked list
 * Maintains insertion/access order without full Map scans
 */

interface CacheNode<T> {
  key: string;
  value: T;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
}

export class LRUCache<T> {
  private maxSize: number;
  private cache: Map<string, CacheNode<T>>;
  private head: CacheNode<T> | null = null; // oldest
  private tail: CacheNode<T> | null = null; // newest

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * Set key-value with O(1) eviction on capacity.
   * Moves accessed node to tail (newest) position.
   */
  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      // Update existing: move to tail
      const node = this.cache.get(key)!;
      node.value = value;
      this.moveToTail(node);
      return;
    }

    // New entry: evict oldest if at capacity
    if (this.cache.size >= this.maxSize && this.head) {
      this.cache.delete(this.head.key);
      this.removeNode(this.head);
    }

    // Insert new node at tail
    const newNode: CacheNode<T> = { key, value, prev: null, next: null };
    this.cache.set(key, newNode);
    this.appendToTail(newNode);
  }

  /**
   * Get value and mark as recently used (move to tail).
   */
  get(key: string): T | undefined {
    const node = this.cache.get(key);
    if (!node) return undefined;
    this.moveToTail(node);
    return node.value;
  }

  /**
   * Check if key exists without updating access order.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete key and node from list.
   */
  delete(key: string): boolean {
    const node = this.cache.get(key);
    if (!node) return false;
    this.cache.delete(key);
    this.removeNode(node);
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Get current size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Iterate over entries in access order (oldest to newest).
   */
  *entries(): Generator<[string, T], void, unknown> {
    let node = this.head;
    while (node) {
      yield [node.key, node.value];
      node = node.next;
    }
  }

  private moveToTail(node: CacheNode<T>): void {
    if (node === this.tail) return; // Already at tail
    this.removeNode(node);
    this.appendToTail(node);
  }

  private removeNode(node: CacheNode<T>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
  }

  private appendToTail(node: CacheNode<T>): void {
    if (this.tail) {
      this.tail.next = node;
      node.prev = this.tail;
    } else {
      this.head = node;
    }
    this.tail = node;
    node.next = null;
  }
}
