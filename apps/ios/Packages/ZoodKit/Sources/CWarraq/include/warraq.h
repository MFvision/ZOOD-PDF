/*
 * warraq.h — C ABI of the ZOOD PDF engine (warraq-core, feature "ffi").
 * Hand-written; kept in sync with src/ffi.rs by the `header_declares_every_export` test.
 *
 * Every call is  method + JSON params + binary blobs  ->  JSON + blobs  (see docs/BRIEF.md).
 * Ownership: free every WarraqReply* with warraq_free_reply; close documents with warraq_close.
 * Page indices in params are 0-based. Mutating methods return the new file as blobs[0].
 */
#ifndef WARRAQ_H
#define WARRAQ_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WarraqDoc WarraqDoc;

typedef struct WarraqReply {
    int32_t is_error;     /* 0 = ok, 1 = json is {"code": ..., "message": ...} */
    char *json;           /* NUL-terminated UTF-8 JSON */
    size_t json_len;      /* bytes in json, without the NUL */
    uint8_t **blobs;      /* blob_count pointers */
    size_t *blob_lens;    /* blob_count lengths */
    size_t blob_count;
} WarraqReply;

/* Open a PDF. password may be NULL. On failure returns NULL and, if error_out is not NULL,
 * stores an error reply in *error_out (free it with warraq_free_reply). */
WarraqDoc *warraq_open(const uint8_t *bytes, size_t len, const char *password, WarraqReply **error_out);

/* Call a document method, e.g. "doc.info", "pages.rotate". params_json may be NULL. */
WarraqReply *warraq_call(WarraqDoc *doc, const char *method, const char *params_json,
                         const uint8_t *const *blobs, const size_t *blob_lens, size_t blob_count);

/* Call a static method, e.g. "pdf.isEncrypted", "pdf.merge". */
WarraqReply *warraq_call_static(const char *method, const char *params_json,
                                const uint8_t *const *blobs, const size_t *blob_lens, size_t blob_count);

void warraq_free_reply(WarraqReply *reply);
void warraq_close(WarraqDoc *doc);

#ifdef __cplusplus
}
#endif

#endif /* WARRAQ_H */
