| Task | PixelPi pass | PW MCP pass | PW script pass | PixelPi ms | PW MCP ms | PW script ms |
|---|---:|---:|---:|---:|---:|---:|
| extract | 5/5 | 5/5 | 5/5 | 23 | 557 | 26 |
| search | 5/5 | 5/5 | 5/5 | 821 | 1661 | 98 |
| form | 5/5 | 5/5 | 5/5 | 556 | 1132 | 69 |
| select | 5/5 | 5/5 | 5/5 | 553 | 1120 | 69 |
| checkbox | 5/5 | 5/5 | 5/5 | 549 | 1632 | 94 |
| long-page | 5/5 | 5/5 | 5/5 | 345 | 1163 | 63 |
| prefilled | 0/5 | 5/5 | 5/5 | — | 1139 | 72 |
| delayed | 0/5 | 5/5 | 5/5 | — | 2482 | 1434 |
| shadow | 5/5 | 5/5 | 5/5 | 298 | 1103 | 63 |
| iframe | 0/5 | 5/5 | 5/5 | — | 1144 | 76 |

Times are medians of 5 trials; failed tasks have no speed score.

Common successful tasks: extract, search, form, select, checkbox, long-page, shadow

| Task | PixelPi output tokens | PW MCP output tokens | Ratio |
|---|---:|---:|---:|
| extract | 83 | 241 | 2.90× |
| search | 346 | 691 | 2.00× |
| form | 421 | 640 | 1.52× |
| select | 285 | 668 | 2.34× |
| checkbox | 203 | 642 | 3.16× |
| long-page | 4,138 | 12,351 | 2.98× |
| shadow | 124 | 365 | 2.94× |
