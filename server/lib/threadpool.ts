// Raise libuv's threadpool size before anything uses it.
//
// Node's default is 4 threads, shared by async filesystem I/O, DNS, zlib, and
// (critically here) sharp's image resizing. On a cold thumbnail cache the
// dashboard fans out many `/library/objects/:id/thumbnail` requests at once;
// with only 4 threads they serialize, which is a large part of a slow first
// paint. 16 gives sharp and the fs reads room to run concurrently without an
// unbounded thread count.
//
// This must run before the pool is first used (lazily, on the first threadpool
// operation), so it is imported as the very first module in server/index.ts.
// An operator-provided value always wins.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

export {};
