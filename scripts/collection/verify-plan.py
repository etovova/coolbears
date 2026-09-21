#!/usr/bin/env python3
"""Verify approved source art and the full private plan without publishing traits."""
import argparse, collections, hashlib, io, json, re, zipfile
from fractions import Fraction
from pathlib import Path
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument('--inputs', required=True)
p.add_argument('--checkpoint', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
checkpoint = Path(a.checkpoint)
plan = json.loads((checkpoint / 'plan.PRIVATE.json').read_text())
checksums = json.loads((checkpoint / 'image-checksums.PRIVATE.json').read_text())
categories = ['Background', 'Body', 'Clothes', 'Mouth', 'Eyes', 'Head', 'Ears']
assert len(plan) == len(checksums) == 10000
counts = {category: collections.Counter(item['traits'][category] for item in plan) for category in categories}
combinations, scores, displayed, ranks, used = set(), set(), set(), set(), set()
with zipfile.ZipFile(a.inputs) as z:
    assert z.testzip() is None
    requirements = json.loads(z.read('inputs/generation-requirements.json'))
    assert all(dict(counts[c]) == requirements['fixed_counts'][c] for c in categories)
    layers = {n.removeprefix('inputs/layers/'): n for n in z.namelist() if n.startswith('inputs/layers/') and n.endswith('.png')}
    assert len(layers) == 454
    for key, name in layers.items():
        blob = z.read(name)
        with Image.open(io.BytesIO(blob)) as im:
            assert im.size == (2000, 2000), key
            im.verify()
    for i, item in enumerate(plan):
        assert item['index'] == checksums[i]['index'] == i
        assert list(item['traits']) == categories
        assert len(item['layers']) == 7
        combo = tuple(item['traits'][category] for category in categories)
        assert combo not in combinations
        combinations.add(combo)
        score = sum((Fraction(10000, counts[c][item['traits'][c]]) for c in categories), Fraction())
        assert score == Fraction(item['exact_score'])
        assert item['score'] == f'{float(score):.6f}'
        assert score not in scores and item['score'] not in displayed and item['rank'] not in ranks
        scores.add(score); displayed.add(item['score']); ranks.add(item['rank'])
        for category, layer in zip(categories, item['layers']):
            key = layer.removeprefix('inputs/layers/').removeprefix('layers/')
            assert key in layers and key.startswith(category + '/')
            used.add(key)
        normalize = lambda s: re.sub(r'[\s-]', '', s).casefold()
        assert normalize(item['traits']['Body']) == normalize(Path(item['layers'][3]).parent.name), 'Mouth/body source mismatch'
    assert used == set(layers)
    ordered = sorted(plan, key=lambda x: Fraction(x['exact_score']), reverse=True)
    assert all(x['rank'] == i + 1 for i, x in enumerate(ordered))
    assert ordered[0]['index'] == 0 and plan[0]['rank'] == 1
    assert list(plan[0]['traits'].values()) == ['Pale Turquoise', 'Gold', 'Gold Suit', 'Diamond Grill', 'Gold Glasses', 'Crown', 'Diamonds']
report = {'schema': 'coolbears-validation-v2', 'supply': len(plan), 'layers': len(layers), 'usedLayers': len(used),
          'uniqueCombinations': len(combinations), 'uniqueExactScores': len(scores), 'uniqueDisplayedScores': len(displayed),
          'uniqueRanks': len(ranks), 'sourcePngStructureVerified': True, 'ownerReserveVerified': True}
Path(a.output).parent.mkdir(parents=True, exist_ok=True)
Path(a.output).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
