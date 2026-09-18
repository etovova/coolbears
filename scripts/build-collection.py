"""Fresh private composition from unmodified original PNGs; no previous token plan."""
from pathlib import Path
from collections import Counter
from fractions import Fraction
from functools import lru_cache
from concurrent.futures import ProcessPoolExecutor
import argparse, hashlib, json, random, secrets, time
from PIL import Image

def read_json(path):
    return json.loads(Path(path).read_text())

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)

def alias(value):
    return ''.join(c.lower() for c in value.strip() if c.isalnum())

def make_plan(inputs, output):
    cfg = read_json(inputs / 'generation-requirements.json')
    manifest = read_json(inputs / 'layers-manifest.json')
    mapping = read_json(inputs / 'source-map.json')
    assert len(manifest) == 454
    for layer in manifest:
        p = inputs / 'layers' / layer['path']
        assert hashlib.sha256(p.read_bytes()).hexdigest() == layer['sha256'], p
    categories = cfg['layer_order']
    assert categories == ['Background', 'Body', 'Clothes', 'Mouth', 'Eyes', 'Head', 'Ears']
    counts = cfg['fixed_counts']
    assert all(sum(c.values()) == 10000 for c in counts.values())
    assert [counts['Eyes'][x] for x in ['Gold Glasses', 'Cyber Goggles', 'Crystal Glasses']] == [50, 60, 90]
    seed_path = output / 'seed.PRIVATE.json'
    if not seed_path.exists():
        write_json(seed_path, {'seed': secrets.token_hex(32), 'version': 'fresh-20260918'})
    rng = random.Random(read_json(seed_path)['seed'])
    rarest = {c: min(counts[c], key=counts[c].get) for c in categories}
    assert rarest == {'Background': 'Pale Turquoise', 'Body': 'Gold', 'Clothes': 'Gold Suit', 'Mouth': 'Diamond Grill', 'Eyes': 'Gold Glasses', 'Head': 'Crown', 'Ears': 'Diamonds'}
    rows = [{c: None for c in categories} for _ in range(10000)]
    rows[0] = rarest.copy()
    pairs = [(b, m) for b in counts['Body'] for m in counts['Mouth'] if (b, m) != ('Gold', 'Diamond Grill')]
    rng.shuffle(pairs)
    for i, (body, mouth) in enumerate(pairs, 1):
        rows[i]['Body'], rows[i]['Mouth'] = body, mouth
    for cat in categories:
        used = Counter(r[cat] for r in rows if r[cat] is not None)
        pool = [value for value, count in counts[cat].items() for _ in range(count - used[value])]
        rng.shuffle(pool)
        for row in rows:
            if row[cat] is None:
                row[cat] = pool.pop()
        assert not pool
    fractions = {c: {v: Fraction(10000, n) for v, n in counts[c].items()} for c in categories}
    def score(row):
        return sum((fractions[c][row[c]] for c in categories), Fraction())
    def display(value):
        # Six decimals, exact half-up rounding; no token-ID or random score bonus.
        scaled = (value.numerator * 1000000 * 2 + value.denominator) // (2 * value.denominator)
        return f'{scaled // 1000000}.{scaled % 1000000:06d}'
    scores = [score(r) for r in rows]
    seen = Counter(display(s) for s in scores)
    swaps = 0
    for i in range(1, 10000):
        attempts = 0
        while seen[display(scores[i])] > 1:
            attempts += 1
            assert attempts < 100000, 'Unable to produce unique frequency scores'
            j = rng.randrange(1, 10000)
            if i == j:
                continue
            cat = rng.choice(['Background', 'Clothes', 'Eyes', 'Head', 'Ears'])
            a, b = rows[i][cat], rows[j][cat]
            if a == b:
                continue
            old_i, old_j = scores[i], scores[j]
            new_i = old_i - fractions[cat][a] + fractions[cat][b]
            new_j = old_j - fractions[cat][b] + fractions[cat][a]
            di, dj = display(new_i), display(new_j)
            seen[display(old_i)] -= 1
            seen[display(old_j)] -= 1
            if di != dj and seen[di] == 0 and seen[dj] == 0:
                rows[i][cat], rows[j][cat] = b, a
                scores[i], scores[j] = new_i, new_j
                seen[di] += 1
                seen[dj] += 1
                swaps += 1
            else:
                seen[display(old_i)] += 1
                seen[display(old_j)] += 1
    assert len(set(scores)) == len(set(display(s) for s in scores)) == 10000
    assert scores[0] == max(scores)
    assert len({tuple(r[c] for c in categories) for r in rows}) == 10000
    for cat in categories:
        assert dict(Counter(r[cat] for r in rows)) == counts[cat]
    lookup = {}
    for layer in mapping:
        key = (layer['category'], alias(layer['trait_value']), alias(layer['mouth_body'] or ''))
        assert key not in lookup
        lookup[key] = layer['relative_path']
    ranks = {idx: rank for rank, idx in enumerate(sorted(range(10000), key=lambda i: scores[i], reverse=True), 1)}
    plan = []
    for i, row in enumerate(rows):
        layers = [lookup[(c, alias(row[c]), alias(row['Body']) if c == 'Mouth' else '')] for c in categories]
        plan.append({'index': i, 'traits': row, 'layers': layers, 'rank': ranks[i], 'score': display(scores[i]), 'exact_score': str(scores[i])})
    used_files = {f for row in plan for f in row['layers']}
    assert used_files == {x['path'] for x in manifest}
    write_json(output / 'plan.PRIVATE.json', plan)
    write_json(output / 'plan-audit.PRIVATE.json', {'version': 'fresh-20260918', 'originalLayers': len(manifest), 'usedLayers': len(used_files), 'combinations': len(plan), 'uniqueRanks': len(ranks), 'uniqueExactScores': len(set(scores)), 'uniqueDisplayedScores': len(set(display(s) for s in scores)), 'countPreservingSwaps': swaps, 'sourceBytesUnchanged': True, 'traitCounts': counts})
    print(json.dumps({'plan': 'ready', 'tokens': 10000, 'originalLayers': len(manifest), 'uniqueScores': 10000, 'countPreservingSwaps': swaps}), flush=True)
    return plan

INPUTS = OUTPUT = None

def initialize_worker(inputs, output):
    global INPUTS, OUTPUT
    INPUTS, OUTPUT = Path(inputs), Path(output)

@lru_cache(maxsize=28)
def get_layer(relative):
    with Image.open(INPUTS / 'layers' / relative) as image:
        assert image.size == (2000, 2000)
        return image.convert('RGBA')

def render(row):
    output = OUTPUT / 'images' / f"{row['index']:04d}.png"
    result = get_layer(row['layers'][0]).copy()
    for layer in row['layers'][1:]:
        result.alpha_composite(get_layer(layer))
    result = result.convert('RGB')
    temp = output.with_suffix('.tmp')
    result.save(temp, format='PNG', compress_level=1)
    data = temp.read_bytes()
    checksum = hashlib.sha256(data).hexdigest()
    pixels = hashlib.sha256(result.tobytes()).hexdigest()
    temp.replace(output)
    return {'index': row['index'], 'sha256': checksum, 'pixel_sha256': pixels, 'bytes': len(data)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=7)
    parser.add_argument('--plan-only', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    plan_path = args.output / 'plan.PRIVATE.json'
    plan = read_json(plan_path) if plan_path.exists() else make_plan(args.inputs, args.output)
    if not args.plan_only:
        (args.output / 'images').mkdir(exist_ok=True)
        start = time.monotonic()
        records = []
        with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize_worker, initargs=(str(args.inputs), str(args.output))) as executor:
            for result in executor.map(render, plan, chunksize=10):
                records.append(result)
                if len(records) % 100 == 0:
                    write_json(args.output / 'progress.json', {'rendered': len(records), 'total': 10000, 'seconds': round(time.monotonic() - start)})
                    print(json.dumps({'rendered': len(records), 'total': 10000}), flush=True)
        write_json(args.output / 'image-checksums.PRIVATE.json', records)
        assert len({r['pixel_sha256'] for r in records}) == 10000, 'Duplicate visible artwork'
        write_json(args.output / 'render-audit.json', {'images': len(records), 'uniquePixelHashes': 10000, 'bytes': sum(r['bytes'] for r in records), 'seconds': round(time.monotonic() - start)})
