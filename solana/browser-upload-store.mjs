export function browserUploadStore(storage = globalThis.localStorage, locks = globalThis.navigator?.locks) {
  const prefix='coolbears-operator:';
  return {
    read(key) { const raw=storage.getItem(prefix+key); return raw===null?null:JSON.parse(raw); },
    write(key,value) {
      const raw=JSON.stringify(value); storage.setItem(prefix+key,raw);
      if(storage.getItem(prefix+key)!==raw)throw Error('Не удалось сохранить журнал. Отправка остановлена.');
    },
    withLock(key,fn) {
      if(!locks?.request)throw Error('Браузер не поддерживает защиту вкладок. Открой страницу в совместимом браузере кошелька.');
      return locks.request(prefix+key,{mode:'exclusive',ifAvailable:true},lock=>{
        if(!lock)throw Error('Операция уже выполняется в другой вкладке.');
        return fn();
      });
    }
  };
}
