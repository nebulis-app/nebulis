# Chunked uploads

Use these endpoints for project archives and processed images too large for one multipart POST. A processing archive is often 3–4 GB. On macOS, one socket send over about 2 GiB fails with `EINVAL`, so the single POST of such a file never reaches the server. With chunked uploads, the client sends the file in parts of a size the server picks. After a failure, it asks which parts arrived and resends only the missing ones.

The single-POST endpoints still work for small files:

- `POST /library/objects/:id/project-archives`
- `POST /library/objects/:id/processed-images`

Above their limit they now answer `413` with `error.maxSize`, instead of failing partway through.

All paths below are under `/api/v1` (or `/api`). Every call needs an admin credential (`X-API-Key` or `Authorization: Bearer`). An upload belongs to the credential that started it. Send the same credential on every later call; any other credential gets `404`.

## Endpoints

| Call | Body | Returns |
|---|---|---|
| `POST /uploads` | JSON `{ target, objectId, filename, size, sha256?, title?, notes?, software? }` | `{ uploadId, chunkSize, chunkCount, maxSize, expiresAt }` |
| `PUT /uploads/:uploadId/chunks/:index` | raw bytes, `Content-Type: application/octet-stream`, `Content-Range: bytes start-end/size` | the status below, plus `chunk: { index, start, end, sha256 }` |
| `GET /uploads/:uploadId` | | `{ received: [{start, end}], receivedBytes, missing: [index], size, chunkSize, chunkCount, status, expiresAt, … }` |
| `POST /uploads/:uploadId/complete` | | the same record as the single POST, with `meta: { sha256, size }` |
| `DELETE /uploads/:uploadId` | | `{ aborted: true, uploadId }` |

- **`target`.** Use `"project-archive"` for `.zip`, `.xpsm` or `.pxiproject` files. Use `"processed-image"` for the processed-image formats (JPG, PNG, WebP, TIFF, XISF, FITS…), which are filed against the object with no session date.
- **Chunks.** Chunk `i` covers bytes `i × chunkSize` to `min(size, (i + 1) × chunkSize) − 1`, both ends included. Every chunk except the last is exactly `chunkSize` bytes.
  - Chunks can arrive in any order, and several at once.
  - Sending a chunk again overwrites it.
  - A chunk counts as received only once all of its bytes are on disk. A dropped connection leaves it in `missing`.
- **Complete.** The server checks that every chunk arrived, the total size, and the `sha256` if one was given. It then files the upload exactly as the single POST would. Hashing a few GB takes a few seconds, so keep the request open. Calling it again after success returns the same record.
- **Memory.** Chunks are streamed to a staging file under `<DATA_DIR>/chunked-uploads`. Nothing is held in memory beyond stream buffers.

## Limits and settings

All settings are environment variables, read when the server starts or when an upload starts.

| Variable | Default | Meaning |
|---|---|---|
| `NEBULIS_MAX_PROJECT_ARCHIVE_BYTES` | 20 GiB | Largest project archive, chunked or single POST |
| `NEBULIS_MAX_PROCESSED_IMAGE_BYTES` | 2 GiB | Largest processed image, chunked or single POST |
| `NEBULIS_UPLOAD_CHUNK_BYTES` | 64 MiB | Chunk size the server hands out, kept between 1 MiB and 1 GiB |
| `NEBULIS_UPLOAD_EXPIRY_HOURS` | 24 | An upload with no new chunk for this long is deleted with its staged bytes |

`POST /uploads` refuses a file up front, before any bytes are sent:

- `415`: the target does not take this extension.
- `413`: the size is over the limit (`error.maxSize`).
- `507`: the staging area or the library lacks room for the declared size (`error.requiredBytes`, `error.freeBytes`).

## Errors

Errors use the usual envelope, `{ ok: false, error: { code, message, … } }`. Extra fields sit next to `code`.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_CHUNK_INDEX`, `INVALID_LENGTH`, `CHUNK_INCOMPLETE` | Index out of range, Content-Length is not the chunk length, or the body ended early (send the chunk again) |
| 403 | `FORBIDDEN` | Not an admin |
| 404 | `UPLOAD_NOT_FOUND` | Unknown, expired or aborted upload, or another credential |
| 409 | `UPLOAD_INCOMPLETE` (`missing`), `CHUNK_IN_PROGRESS`, `UPLOAD_NOT_ACTIVE`, `UPLOAD_COMPLETING` | Complete called too early, the same chunk sent twice at once, or a chunk sent after complete |
| 410 | `UPLOAD_LOST` | The staged file disappeared; start again |
| 413 | `FILE_TOO_LARGE` (`maxSize`), `CHUNK_TOO_LARGE` | |
| 415 | `UNSUPPORTED_FILE_TYPE`, `UNSUPPORTED_MEDIA_TYPE` | Wrong extension for the target, or a chunk not sent as `application/octet-stream` |
| 416 | `INVALID_RANGE` (`expected`) | Content-Range does not match the chunk |
| 422 | `VALIDATION_ERROR`, `INVALID_FILENAME`, `INVALID_SIZE`, `INVALID_SHA256`, `INVALID_OBJECT`, `CHECKSUM_MISMATCH` (`expected`, `actual`), `SIZE_MISMATCH` | |
| 507 | `INSUFFICIENT_STORAGE` | Not enough room for the declared size |

## Client example (Python)

```python
import hashlib, os, time, requests

BASE = "http://nebulis.local:3000/api/v1"
HEADERS = {"X-API-Key": os.environ["NEBULIS_API_KEY"]}

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 << 20), b""):
            h.update(block)
    return h.hexdigest()

def upload_archive(path, object_id, title="", software=""):
    size = os.path.getsize(path)
    start = requests.post(f"{BASE}/uploads", headers=HEADERS, json={
        "target": "project-archive", "objectId": object_id,
        "filename": os.path.basename(path), "size": size,
        "sha256": sha256_of(path), "title": title, "software": software,
    })
    start.raise_for_status()
    up = start.json()["data"]
    upload_id, chunk = up["uploadId"], up["chunkSize"]

    # Send whatever is missing. After a failure, ask the server again and retry.
    for attempt in range(5):
        status = requests.get(f"{BASE}/uploads/{upload_id}", headers=HEADERS).json()["data"]
        if not status["missing"]:
            break
        with open(path, "rb") as f:
            for i in status["missing"]:
                first = i * chunk
                f.seek(first)
                data = f.read(min(chunk, size - first))
                try:
                    r = requests.put(
                        f"{BASE}/uploads/{upload_id}/chunks/{i}",
                        headers={**HEADERS,
                                 "Content-Type": "application/octet-stream",
                                 "Content-Range": f"bytes {first}-{first + len(data) - 1}/{size}"},
                        data=data, timeout=600)
                    r.raise_for_status()
                except requests.RequestException as err:
                    print(f"chunk {i} failed ({err}); will resume")
                    time.sleep(2 ** attempt)
                    break

    done = requests.post(f"{BASE}/uploads/{upload_id}/complete", headers=HEADERS, timeout=3600)
    done.raise_for_status()
    body = done.json()
    print("stored", body["data"]["filename"], body["meta"]["size"], body["meta"]["sha256"])
    return body["data"]

upload_archive("M52_project.zip", "M52", title="HOO", software="PixInsight")
```

The same flow with `curl`, for one chunk:

```sh
curl -X PUT "$BASE/uploads/$ID/chunks/3" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/octet-stream' \
  -H "Content-Range: bytes $((3*67108864))-$((4*67108864-1))/$SIZE" \
  --data-binary @<(dd if=archive.zip bs=67108864 skip=3 count=1 2>/dev/null)
```
