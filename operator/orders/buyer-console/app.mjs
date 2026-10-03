import config from 'private-console:config';
import {getWallets} from '@wallet-standard/app';
import {createPrivateBuyerConsole} from './factory.mjs';
import {mountPrivateBuyerConsole} from './view.mjs';
const notice=document.getElementById('configuration');
if(!config)notice.textContent='This candidate is not configured. No wallet, storage or network action is enabled.';
else try{mountPrivateBuyerConsole({controller:createPrivateBuyerConsole(config),registry:getWallets()});}
catch{notice.textContent='The private configuration or browser capabilities are unavailable. No purchase action is enabled.';}
