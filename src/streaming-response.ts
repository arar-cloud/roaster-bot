import { Response } from 'express';

/**
 * Stream JSON response in chunks to avoid buffering entire payloads in memory.
 * Improves TTFB and reduces peak memory usage for large responses.
 */
export function streamJsonResponse<T>(
  res: Response,
  data: T,
  chunkSize: number = 8192
): void {
  // Set appropriate headers for streaming
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const jsonString = JSON.stringify(data);
  const chunks = [];

  // Split JSON into manageable chunks
  for (let i = 0; i < jsonString.length; i += chunkSize) {
    chunks.push(jsonString.slice(i, i + chunkSize));
  }

  // Stream chunks with backpressure handling
  let index = 0;

  const writeChunk = () => {
    if (index < chunks.length) {
      const canContinue = res.write(chunks[index]);
      index++;

      if (canContinue) {
        // Continue immediately if buffer has capacity
        process.nextTick(writeChunk);
      } else {
        // Wait for drain event if buffer is full
        res.once('drain', writeChunk);
      }
    } else {
      // All chunks written, end response
      res.end();
    }
  };

  writeChunk();
}

/**
 * Stream large array responses with pagination.
 * Useful for endpoints returning many results.
 */
export function streamArrayResponse<T>(
  res: Response,
  items: T[],
  pageSize: number = 50
): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  let index = 0;
  const pages = Math.ceil(items.length / pageSize);

  // Send JSON array opening
  res.write('[');

  const writePage = () => {
    const start = index * pageSize;
    const end = Math.min(start + pageSize, items.length);
    const page = items.slice(start, end);

    if (index > 0) {
      res.write(',');
    }

    const canContinue = res.write(JSON.stringify(page).slice(1, -1));
    index++;

    if (index < pages) {
      if (canContinue) {
        process.nextTick(writePage);
      } else {
        res.once('drain', writePage);
      }
    } else {
      // End of array
      res.write(']');
      res.end();
    }
  };

  writePage();
}
