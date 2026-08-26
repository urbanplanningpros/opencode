(async()=>{
  const encoded=window.__BRAND_CSS_GZ||"";
  if(!encoded) return;
  const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
  const css=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const style=document.createElement("style");
  style.textContent=css;
  document.head.append(style);
})();
