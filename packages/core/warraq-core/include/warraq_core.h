/*
 * warraq_core.h — the C ABI of the core (packages/core/warraq-core/src/ffi.rs),
 * for the iOS app and any other host that links libwarraq_core.a.
 *
 * Every call answers a WarraqReply: a code (WARRAQ_OK or a WARRAQ_E_* code),
 * JSON as a NUL-terminated UTF-8 string — on an error
 * {"code":"E_PASSWORD","message":"…"} — and bytes beside the JSON as
 * (pointer, length) buffers. warraq_free frees all of it at once. Bytes and
 * strings passed in are only read during the call and stay the caller's.
 * A document handle is used from one thread at a time and closed with
 * warraq_close.
 *
 * Kept in step with ffi.rs by a Rust test (`the_c_header_declares_every_exported_function`).
 */
#ifndef WARRAQ_CORE_H
#define WARRAQ_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    WARRAQ_OK = 0,
    WARRAQ_E_ARGS = 1,        /* arguments that do not parse, a null pointer, text that is not UTF-8 */
    WARRAQ_E_UNKNOWN_OP = 2,  /* no tool operation of that name */
    WARRAQ_E_PARSE = 3,       /* not a PDF, or one too damaged to read */
    WARRAQ_E_PASSWORD = 4,    /* encrypted; the password is missing or wrong */
    WARRAQ_E_PAGE = 5,        /* a page index past the last page */
    WARRAQ_E_RENDER = 6,      /* the page could not be drawn */
    WARRAQ_E_FONT = 7,        /* a font that cannot be read or subset */
    WARRAQ_E_EDIT = 8,        /* an edit that cannot be made as asked */
    WARRAQ_E_IO = 9,          /* bytes that could not be written */
    WARRAQ_E_INDEX = 10,      /* a Library index that cannot be read */
    WARRAQ_E_SIGN = 11,       /* signing or verifying failed */
    WARRAQ_E_PANIC = 12,      /* the core panicked and was caught: close the handle, open again */
    WARRAQ_E_OTHER = 13       /* anything else; the message says what */
};

/* An open document. Opaque. */
typedef struct WarraqDocument WarraqDocument;

/* Bytes the caller lends to a call. */
typedef struct WarraqBlob {
    const uint8_t *ptr;
    size_t len;
} WarraqBlob;

/* Bytes the core hands back inside a reply. Empty bytes are a null ptr, len 0. */
typedef struct WarraqBuffer {
    uint8_t *ptr;
    size_t len;
} WarraqBuffer;

/* What every call answers. Free it with warraq_free, once. */
typedef struct WarraqReply {
    int32_t code;         /* WARRAQ_OK or a WARRAQ_E_* code */
    char *json;           /* NUL-terminated UTF-8 JSON; never null */
    WarraqBuffer *blobs;  /* blob_count buffers, or null */
    size_t blob_count;
} WarraqReply;

/* The core's version, a static string: never freed. */
const char *warraq_version(void);

/* Frees a reply and everything in it. */
void warraq_free(WarraqReply reply);

/* A tool operation that needs no open document ("pages.combine",
 * "library.search", …). args may be null (no arguments); blobs may be null
 * when blob_count is 0. */
WarraqReply warraq_call_static(const char *op, const char *args,
                               const WarraqBlob *blobs, size_t blob_count);

/* Opens a PDF from its bytes. On WARRAQ_OK *out is the handle and the JSON
 * is {"pages":n}; on an error *out is null. password may be null. */
WarraqReply warraq_open(const uint8_t *bytes, size_t len, const char *password,
                        WarraqDocument **out);

/* Closes a handle. Null is ignored. */
void warraq_close(WarraqDocument *doc);

/* The number of pages; 0 for a null handle. */
size_t warraq_page_count(const WarraqDocument *doc);

/* {"width":w,"height":h} in points, after the page's own rotation. */
WarraqReply warraq_page_size(WarraqDocument *doc, size_t index);

/* {"width":px,"height":px}; blob 0 is the RGBA8 pixels, premultiplied over
 * white. scale is clamped to 0.05 … 8. */
WarraqReply warraq_render_page(WarraqDocument *doc, size_t index, float scale);

/* {"text":"…"}: the page's text in logical order, lines joined by \n. */
WarraqReply warraq_extract_text(WarraqDocument *doc, size_t index);

/* {"lines":[{"text","x","y","width","height","direction":"rtl"|"ltr"}]} */
WarraqReply warraq_text_lines(WarraqDocument *doc, size_t index);

/* {"pages":[…]}: the pages holding query, Arabic-aware. */
WarraqReply warraq_search(WarraqDocument *doc, const char *query);

/* {"title","author","producer","creator","pages","encrypted","engine"} */
WarraqReply warraq_metadata(WarraqDocument *doc);

/* {"paragraphs":[{"index","text","x","y","width","height","direction",
 *   "alignment","fontSize","lineCount"}]} in device space. */
WarraqReply warraq_paragraphs(WarraqDocument *doc, size_t index);

/* Draws a line of text at (x, y) points from the page's top-left corner in
 * the given font file (a TrueType/OpenType face). Answers {}. */
WarraqReply warraq_add_text(WarraqDocument *doc, size_t index, float x, float y,
                            float size, const char *text,
                            const uint8_t *font, size_t font_len);

/* Replaces a paragraph with reflowed, shaped text. Answers
 * {"linesDrawn","fontSubstituted","shrunk","overflowed","fontSize"}. */
WarraqReply warraq_replace_paragraph(WarraqDocument *doc, size_t index,
                                     size_t paragraph, const char *text,
                                     const uint8_t *font, size_t font_len);

/* The document's bytes as edited — blob 0, an incremental update on top of
 * the original wherever possible; JSON {"bytes":n}. */
WarraqReply warraq_save(WarraqDocument *doc);

/* A tool operation on an open document: op names it ("pages.rotate"), args
 * is JSON (or null), blobs carries bytes. */
WarraqReply warraq_call(WarraqDocument *doc, const char *op, const char *args,
                        const WarraqBlob *blobs, size_t blob_count);

#ifdef __cplusplus
}
#endif

#endif /* WARRAQ_CORE_H */
