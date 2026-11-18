"""Parse the CAB / BANCA partner-wise persistency workbook into a tidy JSON + run consistency checks."""
import json, sys, datetime
import openpyxl

SRC, OUT = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(SRC, data_only=True)
issues = []

def num(v):
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    s = str(v).strip().replace(',', '')
    if s in ('', '-'): return None
    try: return float(s)
    except ValueError: return None

def mlabel(d):
    return d.strftime("%b'%y")

NAME_FIX = {'PROSALES': 'Prosales', 'UTKARSH BANK': 'Utkarsh Bank', 'FINCARE BANK': 'Fincare Bank',
            'SHIVALIK BANK': 'Shivalik Bank', 'Shivalik bank': 'Shivalik Bank', 'VKGB': 'VKGB',
            'AU Small  finance': 'AU Small Finance', 'Pashim Banga Bank': 'Paschim Banga Bank'}
CANON = {}
def fixname(s):
    s = ' '.join(str(s).split()) if s else s
    if not s: return s
    for k, v in NAME_FIX.items():
        if ' '.join(k.split()).lower() == s.lower(): s = v; break
    if s.lower() in ('au small finace', 'au small finance'): s = 'AU Small Finance'
    if s.lower() == 'bfsi': s = 'BFSI'
    if s == 'PROSALES': s = 'Prosales'
    return CANON.setdefault(s.lower(), s)

# ---------------- CAB ----------------
ws = wb.worksheets[0]
starts = [c for c in range(1, ws.max_column + 1) if ws.cell(2, c).value == 'Cohort']
cab = {}      # cohort -> partner -> month -> {base, col, p, cat}
cab_tot = {}  # cohort -> month -> {base, col, p}   (the sheet's own "13M%" row)
months = []
def normcat(c):
    c = str(c).strip()
    if c.lower().endswith('total'): return None
    return c[:1].upper() + c[1:].lower()
for s in starts:
    m = mlabel(ws.cell(1, s).value); months.append(m)
    cohort = cat = None
    for r in range(3, ws.max_row + 1):
        c0, c1, c2 = ws.cell(r, s).value, ws.cell(r, s + 1).value, ws.cell(r, s + 2).value
        col, nc, gt, act = (num(ws.cell(r, s + k).value) for k in (3, 4, 5, 6))
        if c0 and str(c0).strip(): cohort = str(c0).strip()
        if c1 and str(c1).strip().endswith('%'):
            if gt: cab_tot.setdefault(cohort, {})[m] = {'base': gt, 'col': col or 0, 'p': (col or 0) / gt}
            continue
        if c1 and str(c1).strip() and normcat(c1): cat = normcat(c1)
        if not c2 or not str(c2).strip() or str(c2).strip() == '-': continue
        name = fixname(c2)
        if name.upper() == 'TOTAL' or not gt: continue
        p = (col or 0) / gt
        if act is not None and abs(act - p) > 0.0005:
            issues.append(f'CAB {cohort} {m} {name}: Actual column {act:.4f} differs from Collected/Total {p:.4f}')
        ser = cab.setdefault(cohort, {}).setdefault(name, {})
        if m in ser:
            issues.append(f'CAB {cohort} {m}: "{name}" appears twice with data ({ser[m]["base"]:.2f} and {gt:.2f} Cr) - both added together')
            b = ser[m]['base'] + gt; cc = ser[m]['col'] + (col or 0)
            ser[m] = {'base': b, 'col': cc, 'p': cc / b, 'cat': ser[m]['cat']}
        else:
            ser[m] = {'base': gt, 'col': col or 0, 'p': p, 'cat': cat}
# checks: identical partner rows in one month (copy-paste), partner sum vs the sheet's cohort total
for cohort, pm in cab.items():
    for m in months:
        rows = [(n, s[m]) for n, s in pm.items() if m in s]
        seen = {}
        for n, d in rows:
            k = (round(d['base'], 5), round(d['col'], 5))
            if k in seen and d['base'] > 0.05:
                issues.append(f'CAB {cohort} {m}: "{n}" and "{seen[k]}" have exactly the same numbers ({d["base"]:.3f} Cr, {d["p"]*100:.1f}%) - looks like a copy-paste')
            seen[k] = n
        sb = sum(d['base'] for _, d in rows)
        t = cab_tot.get(cohort, {}).get(m)
        if t and abs(sb - t['base']) > 0.05:
            issues.append(f'CAB {cohort} {m}: partners listed add to {sb:.2f} Cr, sheet total row says {t["base"]:.2f} Cr (diff {t["base"]-sb:+.2f})')

# ---------------- BANCA ----------------
ws = wb.worksheets[1]
banca, banca_tot = {}, {}
r = 1
while r <= ws.max_row:
    v = ws.cell(r, 1).value
    if v and str(v).strip() in ('13M', '25M', '37M', '49M', '61M'):
        cohort = str(v).strip(); hdr = r + 1
        mcols = []
        for c in range(2, ws.max_column + 1, 3):
            h = ws.cell(hdr, c).value
            if h is None: continue
            mm = mlabel(h) if hasattr(h, 'strftime') else str(h).strip()
            mcols.append((mm, c))
        rr = r + 3
        while rr <= ws.max_row and ws.cell(rr, 1).value not in (None, ''):
            name = fixname(ws.cell(rr, 1).value)
            for mm, c in mcols:
                base, pv = num(ws.cell(rr, c).value), num(ws.cell(rr, c + 2).value)
                if name == 'Grand Total':
                    if base: banca_tot.setdefault(cohort, {})[mm] = {'base': base, 'p': pv}
                    continue
                if not base or pv is None: continue
                if (pv >= 0.999 or pv == 0) and base > 0.1:
                    issues.append(f'BANCA {cohort} {mm} {name}: persistency shows {pv*100:.0f}% on base {base:.2f} Cr (other months are far off) - please check')
                banca.setdefault(cohort, {}).setdefault(name, {})[mm] = {'base': base, 'p': pv}
            rr += 1
        r = rr
    r += 1

# Corrections confirmed by the RA team (18 Nov 2026): in BANCA 37M, Sep'25 and Oct'25, the Shivalik Bank and
# Paschim Banga Bank rows were swapped in the source sheet. Swap them back.
# Also swapped back (rows clearly interchanged; month before and after line up only after the swap):
# 49M Sep'25 Shivalik/Paschim Banga, 49M Jun'26 and Sep'26 SBM/Utkarsh.
SWAPS = [('37M', "Sep'25", 'Shivalik Bank', 'Paschim Banga Bank'), ('37M', "Oct'25", 'Shivalik Bank', 'Paschim Banga Bank'),
         ('49M', "Sep'25", 'Shivalik Bank', 'Paschim Banga Bank'),
         ('49M', "Jun'26", 'SBM Bank', 'Utkarsh Bank'), ('49M', "Sep'26", 'SBM Bank', 'Utkarsh Bank')]
for cohort, mm, a, b in SWAPS:
    pa, pb = banca[cohort][a], banca[cohort][b]
    pa[mm], pb[mm] = pb[mm], pa[mm]

# BANCA 61M Sep'26: five rows were shuffled in the source sheet. Correct owner of each row, as confirmed
# from the corrected sheet (bases match it; this mapping also reproduces the Grand Total % exactly).
REASSIGN = {('61M', "Sep'26"): {'Fincare Bank': 'Paschim Banga Bank', 'Paschim Banga Bank': 'VKGB', 'Satara Bank': 'SBM Bank',
                                'VKGB': 'Shivalik Bank', 'SBM Bank': 'Fincare Bank', 'Shivalik Bank': 'Satara Bank'}}
for (cohort, mm), mapping in REASSIGN.items():
    old = {n: banca[cohort][n].get(mm) for n in mapping.values()}
    for new_name, from_name in mapping.items():
        if old[from_name] is not None: banca[cohort].setdefault(new_name, {})[mm] = old[from_name]

# Banca checks: partner bases add to grand total; base-weighted % equals grand total %
for cohort, tm in banca_tot.items():
    for mm, t in tm.items():
        parts = [d[mm] for d in banca.get(cohort, {}).values() if mm in d]
        sb = sum(x['base'] for x in parts)
        wp = sum(x['base'] * x['p'] for x in parts) / sb if sb else None
        if abs(sb - t['base']) > 0.02:
            issues.append(f'BANCA {cohort} {mm}: partner bases add to {sb:.2f} Cr, Grand Total says {t["base"]:.2f} Cr')
        if wp is not None and t['p'] is not None and abs(wp - t['p']) > 0.002:
            issues.append(f'BANCA {cohort} {mm}: base-weighted partner % = {wp*100:.1f}%, Grand Total % = {t["p"]*100:.1f}%')

# Partner-share jumps (possible swapped rows)
for ch, src in (('CAB', cab), ('BANCA', banca)):
    for cohort, pm in src.items():
        for name, ser in pm.items():
            prev = None
            for mm in months:
                if mm not in ser: continue
                b = ser[mm]['base']
                if prev and prev > 0.3 and (b / prev > 3 or b / prev < 0.33):
                    issues.append(f'{ch} {cohort} {name}: base jumps {prev:.2f} → {b:.2f} Cr in {mm} — please check')
                prev = b

def r4(x): return x if (x is None or isinstance(x, str)) else round(x, 6)
def pack(src):
    return {c: {n: {m: {k: r4(v) for k, v in d.items()} for m, d in ser.items()} for n, ser in pm.items()} for c, pm in src.items()}

out = {'months': months, 'CAB': {'partners': pack(cab), 'total': pack({'x': cab_tot})['x']},
       'Banca': {'partners': pack(banca), 'total': pack({'x': banca_tot})['x']}}
json.dump(out, open(OUT, 'w'), indent=None, separators=(',', ':'))
print('months', months[0], '..', months[-1], len(months))
for ch in ('CAB', 'Banca'):
    print(ch, {c: len(v) for c, v in out[ch]['partners'].items()})
open(OUT.replace('.json','_checks.txt'),'w').write('\n'.join(issues))
print('\nISSUES (%d):' % len(issues))
for i in issues: print(' -', i)
