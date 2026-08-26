(async()=>{
  try {
    const encoded=window.__BRAND_APP_GZ||"";
    if(!encoded) throw new Error("Brand dashboard application payload missing");
    const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
    const source=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    (0,eval)(source);
  } catch(error) {
    console.error(error);
    document.getElementById("boot").innerHTML=`<div class="boot-mark">!</div><h1>Dashboard failed to load</h1><p>${String(error)}</p>`;
  }
})();
