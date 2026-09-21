"""Recompute approved collection statistics; never modify private source files."""
from collections import Counter
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import sys
from zipfile import ZipFile
from PIL import Image

reference_dir, metadata_dir, source_zip = map(Path, sys.argv[1:4])
plan_bytes = (reference_dir / 'plan.PRIVATE.json').read_bytes()
plan = json.loads(plan_bytes)
assert len(plan) == 10000
categories = ['Background', 'Body', 'Clothes', 'Mouth', 'Eyes', 'Head', 'Ears']
frequencies = {c: Counter(p['traits'][c] for p in plan) for c in categories}
with ZipFile(source_zip) as z:
    requirements = json.loads(z.read('inputs/generation-requirements.json'))
    layer_manifest = json.loads(z.read('inputs/layers-manifest.json'))
    source_map = json.loads(z.read('inputs/source-map.json'))
    layer_refs = {entry['path']: entry for entry in layer_manifest}
    trait_refs = {entry['relative_path']: entry for entry in source_map}
    layer_names = {n.removeprefix('inputs/layers/') for n in z.namelist()
                   if n.startswith('inputs/layers/') and n.lower().endswith('.png')}
    assert len(layer_names) == 454
    assert set(layer_refs) == layer_names == set(trait_refs)
    for name in layer_names:
        raw = z.read('inputs/layers/' + name)  # ZipFile also verifies the CRC.
        assert len(raw) == layer_refs[name]['bytes']
        assert hashlib.sha256(raw).hexdigest() == layer_refs[name]['sha256']
        with Image.open(io.BytesIO(raw)) as im:
            assert im.format == 'PNG'
            assert im.size == (2000, 2000)
            im.verify()

for category in categories:
    assert dict(frequencies[category]) == requirements['fixed_counts'][category], f'{category}: planned frequencies changed'

def normalized(value):
    return re.sub(r'[\s-]+', '', value).casefold()

combinations, scores, displayed, ranks = set(), set(), set(), set()
ranked = []
for index, item in enumerate(plan):
    assert item['index'] == index
    assert list(item['traits']) == categories
    assert [p.split('/')[0] for p in item['layers']] == categories
    assert all(p in layer_names for p in item['layers'])
    for category, layer_path in zip(categories, item['layers']):
        source = trait_refs[layer_path]
        assert source['category'] == category
        assert source['trait_value'] == item['traits'][category]
        if category == 'Mouth':
            assert normalized(source['mouth_body']) == normalized(item['traits']['Body'])
    combo = tuple(item['traits'][c] for c in categories)
    assert combo not in combinations
    combinations.add(combo)
    score = sum((Fraction(10000, frequencies[c][item['traits'][c]]) for c in categories), Fraction())
    assert score == Fraction(item['exact_score'])
    with localcontext() as ctx:
        ctx.prec = 80
        display = format(Decimal(score.numerator) / Decimal(score.denominator), '.6f')
    assert display == item['score']
    assert score not in scores and display not in displayed and item['rank'] not in ranks
    scores.add(score); displayed.add(display); ranks.add(item['rank']); ranked.append((score, index))
    metadata = json.loads((metadata_dir / f'{index:04d}.json').read_text())
    assert metadata['properties']['rarity']['rank'] == item['rank']
    assert metadata['properties']['rarity']['score'] == item['score']
    for category in categories:
        recorded = metadata['properties']['rarity']['trait_frequencies'][category]
        actual = frequencies[category][item['traits'][category]]
        assert recorded['count'] == actual and recorded['percentage'] == actual / 100

assert ranks == set(range(1, 10001))
for rank, (_, index) in enumerate(sorted(ranked, reverse=True), 1):
    assert plan[index]['rank'] == rank
assert plan[0]['rank'] == 1
report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': True, 'items': 10000, 'sourceLayersVerified': 454,
          'sourceLayerHashesMatched': 454, 'sourceLayerDimensionsMatched': 454,
          'allLayerTraitMappingsMatch': True, 'allBodyMouthVariantsMatch': True,
          'allFixedCountsMatchSavedRequirements': True,
          'uniqueCombinations': len(combinations), 'uniqueExactScores': len(scores),
          'uniqueDisplayedScores': len(displayed), 'uniqueRanks': len(ranks),
          'allMetadataFrequenciesMatch': True, 'rankOrderRecomputed': True,
          'planSha256': hashlib.sha256(plan_bytes).hexdigest(), 'sourcesUnmodified': True}
output = Path(__file__).parent / 'reports' / 'plan.json'
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
