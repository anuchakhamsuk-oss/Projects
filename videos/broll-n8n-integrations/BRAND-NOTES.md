# Brand marks used in this composition

Every logo is the **official mark**, taken from the `simple-icons` package
(npm, MIT-licensed project; the marks themselves remain each brand's property).
Nothing is redrawn or approximated — `/media-use` is explicit that logos are
"never redrawn", and an approximated mark is worse than none.

| Node | Mark | Brand colour |
| --- | --- | --- |
| n8n (core) | official | `#EA4B71` |
| LINE | official | `#00C300` |
| Gmail | official | `#EA4335` |
| Google Sheets | official | `#34A853` |
| Google Calendar | official | `#4285F4` |
| WhatsApp | official | `#25D366` |
| Shopify | official | `#7AB55C` |
| Database / HTTP Request / Webhook | drawn glyphs | neutral `#9FB4D8` |

The last three are **n8n's own generic node types**, not companies, so a drawn
glyph is the correct choice there.

## Two brands from the reference image are missing, on purpose

The reference frame showed **Slack** and **OpenAI**. Neither ships in
simple-icons — both were removed from the set after the trademark holders
asked. Redrawing them would ignore that signal, so those nodes were replaced
with **LINE** and **Shopify**, which have official marks available and are a
better fit for Thai SME customers anyway (LINE OA is the channel they actually
use; Slack barely registers here).

To put Slack or OpenAI back: download the mark from that company's own brand /
press page, drop the SVG into `assets/`, and it can be swapped in.

## Before running this as a paid ad

Showing third-party marks to indicate real integrations is ordinary nominative
use, and n8n genuinely integrates with all of these. Even so, several of these
brands publish their own usage guidelines (Google's are the strictest about
colour, spacing and lock-ups). Worth a read if this runs as paid media rather
than organic content.
