"""Diagnose v3 layer-selection ambiguity without exposing trait values, paths, CIDs or images."""
from pathlib import Path
from collections import defaultdict, Counter
import io, json, os, zipfile

base=Path(os.environ['RUNNER_TEMP'])/'coolbears-verified-recovery'
with zipfile.ZipFile(base/'recovery.zip') as rz:
    with zipfile.ZipFile(io.BytesIO(rz.read('original_private_recovery.zip'))) as orig:
        v3_bytes=orig.read('V3_Metadata_and_Reports.zip')
with zipfile.ZipFile(io.BytesIO(v3_bytes)) as v3:
    root='CoolBears_10000_v3/'
    plan=json.loads(v3.read(root+'generation_plan.json'))
    layers=json.loads(v3.read(root+'reports/source_layers.json'))

by_key=defaultdict(list)
for x in layers:
    by_key[(x['category'],x['trait_value'])].append(x)

dup_keys=Counter()
choice_sizes=Counter()
mouth_body_population=defaultdict(Counter)
ambiguous_usage=Counter()
resolution_shapes=Counter()
first_case=None
for (cat,_),xs in by_key.items():
    if len(xs)>1:
        dup_keys[cat]+=1
        choice_sizes[(cat,len(xs))]+=1
        for x in xs:
            mb=x.get('mouth_body')
            mouth_body_population[cat]['blank' if mb in (None,'','None') else 'set']+=1

cats=['Background','Body','Clothes','Mouth','Eyes','Head','Ears']
for item in plan:
    attrs=item['attributes']; body=attrs.get('Body')
    for cat in cats:
        xs=by_key[(cat,attrs[cat])]
        if len(xs)<=1: continue
        ambiguous_usage[cat]+=1
        exact=[x for x in xs if x.get('mouth_body')==body]
        generic=[x for x in xs if x.get('mouth_body') in (None,'','None')]
        shape=(cat,len(xs),len(exact),len(generic))
        resolution_shapes[shape]+=1
        if first_case is None and not (len(exact)==1 or (len(exact)==0 and len(generic)==1)):
            first_case={'category':cat,'choiceCount':len(xs),'exactBodyMatches':len(exact),'genericMatches':len(generic),'distinctMouthBodyLabels':len(set(str(x.get('mouth_body')) for x in xs))}

result={
 'schema':1,
 'status':'PRIVATE_LAYER_SELECTION_DIAGNOSTIC',
 'duplicateTraitKeysByCategory':dict(dup_keys),
 'choiceSizeHistogram':[{'category':c,'choices':n,'keys':k} for (c,n),k in sorted(choice_sizes.items())],
 'mouthBodyPopulationByCategory':{c:dict(v) for c,v in mouth_body_population.items()},
 'ambiguousTraitUsagesByCategory':dict(ambiguous_usage),
 'resolutionShapes':[{'category':c,'choices':n,'exactBodyMatches':e,'genericMatches':g,'usages':v} for (c,n,e,g),v in sorted(resolution_shapes.items())],
 'firstUnresolvedShape':first_case,
 'traitsExposed':False,'pathsExposed':False,'cidsExposed':False,'imagesExposed':False,'walletOperations':False,'uploadsPerformed':False
}
out=Path('build/private-layer-selection-diagnostic');out.mkdir(parents=True,exist_ok=True)
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
