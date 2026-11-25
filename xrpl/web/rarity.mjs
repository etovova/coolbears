const copy = {
  en: {title:'Look up a CoolBear', label:'Mint number (0000–9999)', show:'Show rarity', rank:'Rank', of:'of', top:'Top', score:'Rarity score', trait:'Trait', value:'Value', frequency:'Share of collection', count:'Bears', error:'Could not load this CoolBear. Try again.', loading:'Loading…'},
  ru: {title:'Редкость CoolBear', label:'Номер выпуска (0000–9999)', show:'Показать редкость', rank:'Место', of:'из', top:'Топ', score:'Балл редкости', trait:'Атрибут', value:'Значение', frequency:'Доля коллекции', count:'Медведей', error:'Не удалось загрузить карточку. Попробуй ещё раз.', loading:'Загрузка…'},
  zh: {title:'查询 CoolBear', label:'铸造编号（0000–9999）', show:'查看稀有度', rank:'排名', of:'/', top:'前', score:'稀有度分数', trait:'属性', value:'特征值', frequency:'占收藏比例', count:'数量', error:'无法加载此 CoolBear，请重试。', loading:'加载中…'}
};
function element(tag, text) {
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  return node;
}
export function mountRarity(container, initialLanguage) {
  let lang=initialLanguage, selected=null, request=0, state='';
  const section=element('section'), title=element('h3'), form=element('form'), label=element('label');
  const input=element('input'), button=element('button'), feedback=element('p'), card=element('div');
  section.className='rarity-lookup';
  input.id='rarity-slot';input.inputMode='numeric';input.pattern='[0-9]{1,4}';input.maxLength=4;input.required=true;
  label.htmlFor=input.id;button.type='submit';feedback.setAttribute('role','status');card.className='rarity-result';
  form.append(label,input,button);section.append(title,form,feedback,card);container.append(section);
  function render() {
    const t=copy[lang]||copy.en, num=new Intl.NumberFormat(lang), pct=new Intl.NumberFormat(lang,{style:'percent',maximumFractionDigits:2});
    title.textContent=t.title;label.textContent=t.label;button.textContent=t.show;feedback.textContent=t[state]||'';
    card.replaceChildren();
    if(!selected)return;
    const {name,image,attributes,properties}=selected;
    const rarity=properties.rarity, heading=element('h4',name), picture=element('img'), info=element('div');
    picture.src=image;picture.alt=name;picture.loading='lazy';picture.width=220;picture.height=220;
    const rank=element('p',t.rank+' '+num.format(rarity.rank)+' '+t.of+' '+num.format(properties.collection_size)+' · '+t.top+' '+pct.format(properties.top_percent/100));
    const score=element('p',t.score+' · '+new Intl.NumberFormat(lang,{minimumFractionDigits:6,maximumFractionDigits:6}).format(Number(rarity.score)));
    const table=element('table'), head=table.createTHead().insertRow();
    for(const text of [t.trait,t.value,t.count,t.frequency]){const th=element('th',text);th.scope='col';head.append(th);}
    const body=table.createTBody();
    for(const a of attributes){
      const r=body.insertRow(), f=rarity.trait_frequencies[a.trait_type];
      for(const text of [a.trait_type,a.value,num.format(f.count),pct.format(f.percentage/100)])r.insertCell().textContent=text;
    }
    info.append(heading,rank,score,table);card.append(picture,info);
  }
  async function show(slot) {
    const current=++request;
    selected=null;state='loading';render();
    try{
      const r=await fetch('/xrpl/metadata/'+slot+'.json',{cache:'no-store'});
      if(!r.ok)throw Error();
      const data=await r.json(), p=data.properties;
      if(!p?.rarity || p.collection_size!==10000 || !Number.isInteger(p.rarity.rank) || p.rarity.rank<1 || p.rarity.rank>10000 ||
         p.top_percent!==p.rarity.rank/100 || !Array.isArray(data.attributes) || data.image!==location.origin+'/xrpl/art/'+slot+'.png' ||
         !data.attributes.every(a=>p.rarity.trait_frequencies[a.trait_type]?.percentage>=0))throw Error();
      if(current!==request)return;
      selected=data;state='';
    }catch{if(current!==request)return;state='error';}
    render();
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if(!/^\d{1,4}$/.test(input.value))return;
    const slot=input.value.padStart(4,'0');input.value=slot;
    const url=new URL(location.href);url.searchParams.set('slot',slot);url.hash='rarity';history.replaceState(null,'',url);
    show(slot);
  });
  render();
  const slot=new URL(location.href).searchParams.get('slot');
  if(/^\d{4}$/.test(slot)){input.value=slot;show(slot);}
  return next=>{lang=next;render();};
}
