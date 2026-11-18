# Partner-wise persistency data

Builds `partner-data.js` (the partner tables on the channel tabs) from the monthly partner-wise workbook.

```
python3 parse.py "CAB & BANCA Partner wise.xlsx" partners.json      # also writes partners_checks.txt
python3 build_js.py partners.json ../../partner-data.js "BANCA partner-wise workbook, data up to <Mon'YY>" Banca
```

`parse.py` checks the workbook (partner rows vs total rows, copy-pasted rows, rows swapped between partners) and
lists anything odd in `partners_checks.txt`; read that before publishing. Known source-sheet swaps are corrected in
the `SWAPS` list. The last argument of `build_js.py` lists the channels to publish (add `CAB` once its data is verified).
