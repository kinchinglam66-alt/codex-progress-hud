/** Bounded stderr classifier. Never retain or expose raw diagnostic text. */
export function createModelCatalogTimeoutReader() {
 let buffer='',discard=false,count=0;
 return {
  count:()=>count,
  push(chunk:Buffer){
   for(const ch of chunk.toString('utf8')){
    if(ch==='\n'){
     if(!discard&&/models_manager|model.?catalog|available models|models_cache/i.test(buffer)&&/timed? ?out|timeout/i.test(buffer))count++;
     buffer='';discard=false;
    }else if(!discard){if(buffer.length>=8192){buffer='';discard=true;}else buffer+=ch;}
   }
  },
 };
}
