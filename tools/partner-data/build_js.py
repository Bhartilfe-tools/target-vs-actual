"""partners.json (from parse.py) -> partner-data.js for the Target vs Actual site."""
import json, sys
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
res = {'months': d['months'], 'source': sys.argv[3] if len(sys.argv) > 3 else '', 'channels': {}}
for ch in (sys.argv[4].split(',') if len(sys.argv) > 4 else ['CAB', 'Banca']):
    cohorts = {}
    for c, pm in d[ch]['partners'].items():
        partners = []
        for name, ser in pm.items():
            s = {}
            for m, v in ser.items():
                row = [round(v['base'], 4), round(v['p'] * 100, 2)]
                if v.get('cat'): row.append(v['cat'])
                s[m] = row
            partners.append({'name': name, 's': s})
        tot = {m: [round(v['base'], 4), round(v['p'] * 100, 2)] for m, v in d[ch]['total'].get(c, {}).items() if v.get('p') is not None}
        cohorts[c] = {'total': tot, 'partners': partners}
    res['channels'][ch] = cohorts
js = ('/* Partner-wise persistency (13M-61M), LY and CY.\n'
      ' * Generated from the partner MIS workbook. Values: [base Rs Cr, persistency %, category].\n'
      ' * "total" is the channel total row of the source sheet. */\n'
      'window.PARTNER_PERSISTENCY = ' + json.dumps(res, separators=(',', ':')) + ';\n')
open(out, 'w').write(js)
print(len(js), 'bytes')
