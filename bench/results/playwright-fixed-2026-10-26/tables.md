| Task | PixelPi pass | PW MCP pass | PW script pass | PixelPi ms | PW MCP ms | PW script ms |
|---|---:|---:|---:|---:|---:|---:|
| extract | 5/5 | 5/5 | 5/5 | 19 | 556 | 20 |
| search | 5/5 | 5/5 | 5/5 | 1012 | 1679 | 100 |
| form | 5/5 | 5/5 | 5/5 | 809 | 1139 | 75 |
| select | 5/5 | 5/5 | 5/5 | 680 | 1122 | 64 |
| checkbox | 5/5 | 5/5 | 5/5 | 673 | 1644 | 94 |
| long-page | 5/5 | 5/5 | 5/5 | 399 | 1159 | 64 |
| prefilled | 5/5 | 5/5 | 5/5 | 815 | 1140 | 76 |
| delayed | 5/5 | 5/5 | 5/5 | 1369 | 2475 | 1436 |
| shadow | 5/5 | 5/5 | 5/5 | 351 | 1103 | 65 |
| iframe | 5/5 | 5/5 | 5/5 | 354 | 1143 | 86 |

Times are medians of 5 trials; failed tasks have no speed score.

Common successful tasks: extract, search, form, select, checkbox, long-page, prefilled, delayed, shadow, iframe

| Task | PixelPi output tokens | PW MCP output tokens | Ratio |
|---|---:|---:|---:|
| extract | 80 | 241 | 3.01× |
| search | 343 | 691 | 2.01× |
| form | 418 | 640 | 1.53× |
| select | 282 | 668 | 2.37× |
| checkbox | 200 | 642 | 3.21× |
| long-page | 4,135 | 12,351 | 2.99× |
| prefilled | 475 | 664 | 1.40× |
| delayed | 202 | 597 | 2.96× |
| shadow | 121 | 365 | 3.02× |
| iframe | 137 | 437 | 3.19× |
