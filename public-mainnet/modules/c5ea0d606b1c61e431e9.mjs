import { request, createGenericFile } from '/public-mainnet/modules/f00551e78105664b932a.mjs';

function createHttpDownloader(context) {
  const downloadOne = async (uri, options = {}) => {
    const response = await context.http.send(request().get(uri).withAbortSignal(options.signal));
    return createGenericFile(response.body, uri);
  };
  const download = async (uris, options = {}) => Promise.all(uris.map(uri => downloadOne(uri, options)));
  const downloadJson = async (uri, options = {}) => {
    const response = await context.http.send(request().get(uri).withAbortSignal(options.signal));
    return response.data;
  };
  return {
    download,
    downloadJson
  };
}

export { createHttpDownloader };

