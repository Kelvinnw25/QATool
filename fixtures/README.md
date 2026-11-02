# Fixtures

Sample input documents. Nothing here is read at runtime by the application.

## `prd/`

| File                                             | Used by                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `PRD_Transaction_Routing_Sanitized.pdf`          | `server/extract/extract.test.js` (PDF parser and block extraction), by relative path |
| `PRD_QR_Manager_Settlement_Report_SANITIZED.pdf` | `server/extract/extract.test.js`, by relative path                                   |
| `01_` to `05_*.pdf`                              | Manual samples for trying the UI by hand. No automated test reads them.              |

Moving or renaming the two `PRD_*` files breaks `npm test`; the paths are literal.
Add documents here only if they are sanitized or synthetic.
