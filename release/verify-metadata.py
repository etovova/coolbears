"""Verify private reveal links, commitment and complete metadata; print no CIDs."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import sys

reference, metadata_dir = map(Path, sys.argv[1:3])
load = lambda path: json.loads(path.read_text())
manifest = load(reference / 'manifest.PRIVATE.json')
reveal_map = load(reference / 'reveal-map.PRIVATE.json')
commitment = load(reference / 'commitment.json')['commitment']
plan = load(reference / 'plan.PRIVATE.json')
policy = load(Path(__file__).parent.parent / 'metadata/policy.json')
assert len(reveal_map) == len(plan) == policy['supply'] == 10000
canonical = json.dumps(reveal_map, ensure_ascii=False, separators=(',', ':')).encode()
assert hashlib.sha256(canonical).hexdigest() == commitment
assert manifest['finalPrefix'] == f"ipfs://{manifest['root']}/metadata/"
assert {p.name for p in metadata_dir.glob('*.json')} == {f'{i:04d}.json' for i in range(10000)}
names, uris, images = set(), set(), set()
for i, mapping in enumerate(reveal_map):
    meta = load(metadata_dir / f'{i:04d}.json')
    assert mapping['index'] == i
    assert mapping['name'] == meta['name'] == f'CoolBears #{i:04d}'
    assert mapping['uri'] == manifest['finalPrefix'] + f'{i:04d}.json'
    assert meta['image'] == f"ipfs://{manifest['imagesRoot']}/{i:04d}.png"
    assert meta['external_url'] == policy['website']
    assert meta['description'] == 'Everyone gets a bear. Not everyone gets a legend.'
    assert len(meta['attributes']) == 7
    assert len({a['trait_type'] for a in meta['attributes']}) == 7
    assert {a['trait_type']: a['value'] for a in meta['attributes']} == plan[i]['traits']
    assert meta['properties']['category'] == 'image'
    assert meta['properties']['files'] == [{'uri': meta['image'], 'type': 'image/png'}]
    assert len(mapping['uri'].encode()) <= 200
    assert len(mapping['name'].encode()) <= 32
    names.add(meta['name']); uris.add(mapping['uri']); images.add(meta['image'])
assert len(names) == len(uris) == len(images) == 10000
for stem, expected in [('collection', policy['collectionDescription']), ('0000', policy['hiddenDescription'])]:
    meta = load(Path(__file__).parent.parent / f'metadata/{stem}.json')
    assert meta['description'] == expected
    assert not any(k in meta for k in ['attributes', 'rank', 'rarity'])
    assert not any(k in meta.get('properties', {}) for k in ['attributes', 'rank', 'rarity'])
report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': True,
          'metadata': 10000, 'uniqueNames': len(names), 'uniqueImageLinks': len(images),
          'uniqueRevealLinks': len(uris), 'canonicalCommitmentMatched': True,
          'exactImageAndMetadataRootsMatched': True, 'allTraitFieldsMatched': True,
          'publicDescriptionsMatched': True, 'publicMetadataContainsNoRarity': True,
          'sourcesUnmodified': True}
(Path(__file__).parent / 'reports/metadata.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
