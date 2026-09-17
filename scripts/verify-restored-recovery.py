"""Verify private backup inventories and exact metadata without publishing traits."""
from pathlib import Path
from fractions import Fraction
from collections import Counter
import csv,hashlib,io,json,os,zipfile
H='00c983a1af436b60008505ad3cd706615bd5a3e01cf1186a7127cbdde69f3252'
CATEGORIES={'Background','Body','Clothes','Mouth','Eyes','Head','Ears'}
def check(ok,message):
    if not ok: raise ValueError(message)
def sha(b): return hashlib.sha256(b).hexdigest()
def checked_zip(b):
    z=zipfile.ZipFile(io.BytesIO(b))
    check(len(z.namelist())==len(set(z.namelist())), 'Duplicate ZIP names')
    check(z.testzip() is None,'ZIP CRC failed')
    check(all(not n.startswith(('/', '\\')) and '..' not in Path(n).parts for n in z.namelist()),'Unsafe archive name')
    return z
base=Path(os.environ['RUNNER_TEMP'])/'coolbears-verified-recovery'
raw=(base/'recovery.zip').read_bytes()
check(len(raw)==153849791 and sha(raw)==H,'Backup checksum differs')
z=checked_zip(raw)
pbytes=Path('launch/candidate.json').read_bytes();p=json.loads(pbytes)
check(z.read('unsigned-packages/mainnet.candidate.json')==pbytes,'Backup is for another deployment package')
final=checked_zip(z.read('final_metadata_PRIVATE.zip'))
manifest_bytes=final.read('manifest.PRIVATE.json');manifest=json.loads(manifest_bytes)
check(sha(manifest_bytes)==p['releaseManifestSha256'],'Manifest differs from final candidate')
check(manifest['revision']=='v3' and manifest['images']==manifest['metadata']==manifest['uniqueScores']==10000,'Wrong manifest policy')
records=manifest['records'];check(len(records)==10000,'Record count differs')
check([x['id'] for x in records]==list(range(10000)),'Record IDs differ')
check(set(final.namelist())=={f'metadata/{i:04d}.json' for i in range(10000)}|{'collection.json','manifest.PRIVATE.json'},'Unexpected final archive files')
original=checked_zip(z.read('original_private_recovery.zip'))
v3=checked_zip(original.read('V3_Metadata_and_Reports.zip'))
root='CoolBears_10000_v3/'
plan=json.loads(v3.read(root+'generation_plan.json'));check(len(plan)==10000,'Plan count differs')
checksums=list(csv.DictReader(io.StringIO(v3.read(root+'reports/image_checksums.csv').decode())))
check(len(checksums)==10000,'Image checksum count differs')
images={int(x['token_id']):x for x in checksums}
metas=[];combos=set();counts=Counter()
for i in range(10000):
    record=records[i];b=final.read(f'metadata/{i:04d}.json');m=json.loads(b)
    check(sha(b)==record['metadataSha256'],'Metadata bytes differ')
    check(m['name']==f'CoolBears #{i:04d}' and m['image']=='ipfs://'+record['imageCid'],'Wrong metadata identity or image link')
    attrs=m['attributes'];check(len(attrs)==7,'Wrong attribute count')
    traits={x['trait_type']:x['value'] for x in attrs};check(set(traits)==CATEGORIES,'Wrong trait categories')
    check(traits==plan[i]['attributes'] and plan[i]['token_id']==i,'Final traits differ from generation plan')
    check(m['properties']==json.loads(v3.read(root+f'metadata/{i:04d}.json'))['properties'],'Final rarity changed during packaging')
    combo=tuple(sorted(traits.items()));check(combo not in combos,'Duplicate logical NFT');combos.add(combo);counts.update(combo)
    check(record['pngSha256']==images[i]['sha256'] and record['pixelSha256']==images[i]['pixel_sha256'] and record['imageBytes']==int(images[i]['bytes']),'Image manifest differs from verified source V3')
    metas.append(m)
rankings=[];display_scores=set();scores=set()
for i,m in enumerate(metas):
    a={x['trait_type']:x['value'] for x in m['attributes']};freq=m['properties']['trait_frequencies']
    check(len(freq)==7 and {x['trait_type'] for x in freq}==CATEGORIES,'Frequency categories differ')
    for x in freq:
        count=counts[(x['trait_type'],x['value'])]
        check(a[x['trait_type']]==x['value'] and count==x['count'] and Fraction(str(x['percent']))==Fraction(count,100),'Frequency/percent mismatch')
    value=sum((Fraction(10000,counts[t]) for t in a.items()),Fraction())
    r=m['properties']['rarity']
    check(value==Fraction(int(r['score_numerator']),int(r['score_denominator'])),'Exact rarity score mismatch')
    check(value not in scores,'Duplicate rarity score');scores.add(value)
    check(r['score_display'] not in display_scores,'Duplicate displayed rarity score');display_scores.add(r['score_display'])
    rankings.append((value,i,r['rank']))
for rank,(_,i,given) in enumerate(sorted(rankings,reverse=True),1):check(rank==given,'Rank mismatch')
check(metas[0]['properties']['rarity']['rank']==1,'Creator token is not rank one')
for a in metas[0]['attributes']:
    cat,value=a['trait_type'],a['value'];same=[n for (c,v),n in counts.items() if c==cat]
    check(counts[(cat,value)]==min(same) and same.count(min(same))==1,'Creator token does not contain unique rarest category value')
source=checked_zip(original.read('SourceLayers.zip'))
layers=json.loads(v3.read(root+'reports/source_layers.json'));check(len(layers)==454,'Source layer count differs')
for layer in layers:
    matches=[n for n in source.namelist() if n.endswith('/'+layer['relative_path']) or n==layer['relative_path']]
    check(len(matches)==1,'Source layer missing or ambiguous')
    data=source.read(matches[0]);check(len(data)==layer['bytes'] and sha(data)==layer['sha256'],'Source layer bytes changed')
# Private tiny inputs for the next local cell-hash verification only.
for name,content in [('reveal.json',z.read('unsigned-packages/reveal.PRIVATE.json')),('manifest.json',manifest_bytes)]:
    q=base/name;q.write_bytes(content);q.chmod(0o600)
result={'schema':1,'status':'RESTORED_BACKUP_INVENTORY_AND_METADATA_VERIFIED','archiveSha256':H,'packageSha256':sha(pbytes),'manifestSha256':sha(manifest_bytes),'sourceLayersHashChecked':454,'metadataHashChecked':10000,'traitEntriesVerified':70000,'uniqueExactRarityScores':10000,'uniqueDisplayedRarityScores':10000,'creatorAllRarestVerified':True,'imageManifestMatchesOriginalV3':True,'readyImagesStoredInThisBackup':False,'readyImageBytesRegeneratedThisRun':False,'mainnetReady':False}
Path('build/private-recovery-restore').mkdir(parents=True,exist_ok=True)
Path('build/private-recovery-restore/inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
