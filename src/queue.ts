/**
 * Queue-based processing module for async operations
 * Implements task queue with acknowledgment semantics, retries, and error recovery
 * Prevents lost work from fire-and-forget async patterns
 */

interface OperationMetrics {
  taskId: string;
  type: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attempts: number;
  success: boolean;
  error?: string;
}

class MetricsCollector {
  private metrics: OperationMetrics[] = [];

  record(metric: OperationMetrics): void {
    this.metrics.push(metric);
    if (this.metrics.length > 1000) {
      this.metrics.shift();
        const durationMs = Date.now() - startTime;
        console.log(`[Task ${task.id}] Success after ${finalAttempts} attempt(s) in ${durationMs}ms`);
    }
  }

  getMetrics(): OperationMetrics[] {
    return [...this.metrics];
  }

  getAverageRetries(taskType: string): number {
    const tasks = this.metrics.filter(m => m.type === taskType);
    if (tasks.length === 0) return 0;
    return tasks.reduce((sum, t) => sum + t.attempts, 0) / tasks.length;
  }
}

export interface Task<T = unknown> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  maxRetries: number;
  createdAt: number;
  priority: 'low' | 'normal' | 'high';
}

export interface TaskResult<T = unknown> {
  taskId: string;
  success: boolean;
  result?: T;
  error?: string;
  attempts: number;
}

export interface QueueConfig {
  maxConcurrent?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryPolicy?: RetryPolicy;
}

/**
 * Calculate exponential backoff delay with jitter and max cap
 * Prevents thundering herd and distributes retry attempts
 */
function calculateBackoffDelay(
  attempt: number,
  policy: RetryPolicy
): number {
  const exponentialDelay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = cappedDelay * policy.jitterFactor * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Determine if error is retryable (transient vs permanent)
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  // Transient errors: network issues, timeouts, rate limits
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('timeout') ||
    message.includes('429') ||
    message.includes('503') ||
    message.includes('socket hang up')
  );
}

interface ShutdownOptions {
  gracefulTimeoutMs?: number;
}

interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

type TaskHandler<T = unknown> = (task: Task<T>) => Promise<TaskResult>;

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoffDelay(attemptNumber: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attemptNumber - 1), maxDelayMs);
  const jitter = Math.random() * 0.1 * exponentialDelay;
  return exponentialDelay + jitter;
}

/**
 * In-memory task queue with exponential backoff retry logic
 */
export class TaskQueue {
  private pending: Map<string, Task> = new Map();
  private processing: Set<string> = new Set();
  private handlers: Map<string, TaskHandler> = new Map();
  private results: Map<string, TaskResult> = new Map();
  private config: Required<QueueConfig>;
  private deadLetterQueue: Map<string, Task & { lastError: string; failureCount: number }> = new Map();
  private correlationIds: Map<string, string> = new Map();

  constructor(config: QueueConfig = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 5,
      baseDelayMs: config.baseDelayMs ?? 100,
      maxDelayMs: config.maxDelayMs ?? 30000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
    };
  }

  /**
   * Get dead-letter queue for inspection and recovery
   */
  getDeadLetterQueue() {
    return Array.from(this.deadLetterQueue.values());
  }

  /**
   * Get count of pending tasks (enqueued but not yet completed)
   */
  getPendingCount(): number {
    return this.tasks.size + this.activeCount;
  }

  /**
   * Register a handler for a specific task type
   */
  registerHandler(type: string, handler: TaskHandler): void {
    if (typeof type !== 'string' || !type) {
      console.error('Invalid task type for handler registration');
      return;
    }
    if (typeof handler !== 'function') {
      console.error('Invalid handler function');
      return;
    }
    this.handlers.set(type, handler);
  }

  /**
   * Enqueue a task for processing
   */
  async enqueue<T>(
    type: string,
    payload: T,
    options?: {
      maxRetries?: number;
      priority?: 'low' | 'normal' | 'high';
    }
  ): Promise<string> {
    if (!type || typeof type !== 'string') {
      throw new Error('Invalid task type');
    }

    const taskId = `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const task: Task<T> = {
      id: taskId,
      type,
      payload,
      attempts: 0,
      maxRetries: options?.maxRetries ?? 3,
      createdAt: Date.now(),
      priority: options?.priority ?? 'normal',
    };

    this.pending.set(taskId, task);
    this.processQueue();
    return taskId;
  }

  /**
   * Process queued tasks with concurrency limit
   */
  private async processQueue(): Promise<void> {
    while (this.processing.size < this.config.maxConcurrent && this.pending.size > 0) {
      // Get highest priority task
      const taskId = this.getNextTaskId();
      if (!taskId) break;

      const task = this.pending.get(taskId);
      if (!task) continue;

      this.pending.delete(taskId);
      this.processing.add(taskId);

      this.processTask(task).catch((error) => {
        console.error(`Failed to process task ${taskId}:`, error);
      });
    }
  }

  /**
   * Get next task ID based on priority ordering
   */
  private getNextTaskId(): string | null {
    const taskIds = Array.from(this.pending.keys());
    if (taskIds.length === 0) return null;

    // Sort by priority (high > normal > low), then by creation time
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    let nextId = taskIds[0];
    let nextPriority = priorityOrder[this.pending.get(nextId)?.priority ?? 'normal'];

    for (const id of taskIds) {
      const task = this.pending.get(id);
      if (!task) continue;
      const priority = priorityOrder[task.priority];
      if (priority < nextPriority ||
          (priority === nextPriority && task.createdAt < (this.pending.get(nextId)?.createdAt ?? Date.now()))) {
        nextId = id;
        nextPriority = priority;
      }
    }

    return nextId;
  }

  /**
   * Process individual task with retry logic and adaptive backoff
   */
  private async processTask(task: Task): Promise<void> {
    const correlationId = this.correlationIds.get(task.id) || `trace-${task.id}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      try {
        task.attempts = attempt + 1;
        console.log(`[${correlationId}] Processing task ${task.id} (attempt ${task.attempts}/${task.maxRetries + 1})`);

        if (attempt > 0) {
          // Apply adaptive backoff on retry
          const delayMs = calculateBackoffDelay(attempt - 1, this.config.baseDelayMs, this.config.maxDelayMs);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const handler = this.handlers.get(task.type);
        if (!handler) {
          throw new Error(`No handler registered for task type: ${task.type}`);
        }

        const result = await handler(task);
        console.log(`[${correlationId}] Task ${task.id} succeeded`);
        this.results.set(task.id, result);
        return; // Success - exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(`[${correlationId}] Task ${task.id} failed (attempt ${attempt + 1}): ${lastError.message}`);

        // Check if error is retryable
        if (!isRetryableError(error) || attempt === task.maxRetries) {
          // Non-retryable or max retries exceeded
          const result: TaskResult = {
            taskId: task.id,
            success: false,
            error: lastError.message,
            attempts: task.attempts,
          };
          this.deadLetterQueue.set(task.id, {
            ...task,
            lastError: lastError.message,
            failureCount: task.attempts,
          });
          this.results.set(task.id, result);
          break; // Exit retry loop
        }
      }
    }

    this.processing.delete(task.id);
    this.processQueue();
  }

  /**
   * Get result of a processed task
   */
  getResult(taskId: string): TaskResult | null {
    return this.results.get(taskId) ?? null;
  }

  /**
   * Get status of a queued or processing task
   */
  getTaskStatus(taskId: string): 'pending' | 'processing' | 'completed' | 'not-found' {
    if (this.pending.has(taskId)) return 'pending';
    if (this.processing.has(taskId)) return 'processing';
    if (this.results.has(taskId)) return 'completed';
    return 'not-found';
  }

  /**
   * Wait for task completion with timeout
   */
  async waitForTask(taskId: string, timeoutMs: number = 30000): Promise<TaskResult | null> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeoutMs) {
      const result = this.results.get(taskId);
      if (result) {
        return result;
      }

      const status = this.getTaskStatus(taskId);
      if (status === 'not-found') {
        return null; // Task was not found
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null; // Timeout
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    pending: number;
    processing: number;
    completed: number;
    handlers: number;
  } {
    return {
      pending: this.pending.size,
      processing: this.processing.size,
      completed: this.results.size,
      handlers: this.handlers.size,
    };
  }

  /**
   * Clear queue and results (use carefully)
   */
  clear(): void {
    this.pending.clear();
    this.processing.clear();
    this.results.clear();
  }

  /**
   * Graceful shutdown with in-flight job cleanup
   */
  async shutdown(options?: ShutdownOptions): Promise<void> {
    const gracefulTimeoutMs = options?.gracefulTimeoutMs ?? 30000;
    const startTime = Date.now();

    // Signal no new tasks accepted
    let isShuttingDown = true;

    // Wait for in-flight tasks to complete
    while (this.processing.size > 0 && Date.now() - startTime < gracefulTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Force cleanup of remaining tasks
    if (this.processing.size > 0) {
      console.warn(`Shutdown timeout: ${this.processing.size} tasks still processing`);
      this.processing.clear();
    }

    // Move pending tasks to dead letter queue
    for (const [taskId, task] of this.pending.entries()) {
      this.deadLetterQueue.set(taskId, {
        ...task,
        lastError: 'Shutdown during pending state',
        failureCount: task.attempts,
      });
    }

    this.pending.clear();
  }
}

/**
 * Global queue instance for application-wide task processing
 */
export const globalQueue = new TaskQueue({
  maxConcurrent: 10,
  baseDelayMs: 200,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
});
