// Synthetic evidence for unit tests ONLY. Never imported by release runtime.
import {PACKAGE_SHA256,REVISION,MANIFEST_SHA256,CAR_SHA256} from '../release-guard.mjs';
export function preparedFixture(base,p){
  const binding={packageSha256:PACKAGE_SHA256,appliesToCurrentCandidate:true};
  return {...structuredClone(base),phase:'prepared',testnetVerified:true,privateStorageVerified:true,mainnetVerified:false,creatorNftVerified:false,publicMintApproved:false,automaticRevealArmed:false,
    evidence:{
      privateStorage:{...binding,status:'passed',collectionRevision:REVISION,manifestSha256:MANIFEST_SHA256,carSha256:CAR_SHA256,partsExpected:48,partsVerified:48,allPartHashesVerified:true,fullReassemblyHashVerified:true},
      correctedTestnetTransactionAudit:{...binding,status:'passed',transactionHistoryVerified:true,receiptsMatchedByMessageHash:true,collectionHistoryComplete:true,operations:['deploy','claim','open','mint']},
      correctedTestnetNft0001:{...binding,status:'verified-live-testnet',nextItemIndex:2,paused:false,nft0OwnerVerified:true,nft1OwnerVerified:true,nft0MetadataUriVerified:true,nft1MetadataUriVerified:true},
      correctedPrerevealMedia:{...binding,status:'passed',metadata0000Available:true,metadata0001Available:true,samePrerevealImage:true,animatedGifVerified:true},
      prerevealMetadataPublication:{...binding,status:'passed',collectionMetadataIpfs:p.collectionMetadataIpfs,preRevealMetadataRootIpfs:p.preRevealMetadataRootIpfs,metadataCount:10000,allMetadataNoAttributes:true,publicReadbackVerified:true,logoSha256:'5d8398d9497deab99a1c57d147df43047131fa9354097ea2879385f3bf6d71e7',bannerSha256:'d3f82a120907b3ec5747628127580b9a1f80757676692361f43a533b5248bb95',strictImageDecodeVerified:true,gifSha256:'b43ab0519db076709b7697dd3c767ab7177610fb163ec25b8c08a5146ba3d312',gifFrames:148,gifDurationMs:4950},
      prerevealGetgemsUi:{...binding,status:'passed',network:'testnet',collectionAddressRaw:p.collectionAddressRaw,logoVisible:true,bannerVisible:true,gifAnimated:true,attributesAbsent:true,percentagesAbsent:true,rankAbsent:true}
    }
  };
}
