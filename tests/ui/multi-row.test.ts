import { expect, it } from 'vitest';
import { buildConversationViews } from '../../src/ui/view-model.js';
import { TaskStore } from '../../src/server/task-store.js';
it('keeps equal host names separate and formats each task independently', () => {
  const store=new TaskStore({nameForConversation:()=>({value:'Same chat name',freshness:'fresh'})});
  for(const id of ['a','b'])store.apply({taskId:id,event:{type:'turn_started'}},0,{conversationKey:id,turnKey:id,isCurrentTurn:true});
  store.apply({taskId:'a',event:{type:'model_progress',phase:'work',progress:0.2}},100);
  store.apply({taskId:'b',event:{type:'waiting',reason:'approval'}},100);
  const views=buildConversationViews(store.conversationRows(200));
  expect(views.map(view=>[view.key,view.title,view.progressPercent])).toEqual([
    ['a','Same chat name',20],['b','Same chat name',null]
  ]);
  expect(views[1]?.statusLabel).toBe('等待审批');
  expect(views[1]?.etaLabel).toBe('工作计时已暂停');
});
it('shows unavailable names explicitly and preserves names as text data', () => {
  const store=new TaskStore();
  store.apply({taskId:'a',title:'Invented',event:{type:'turn_started'}},0,{conversationKey:'a',turnKey:'a',isCurrentTurn:true});
  const rows=store.conversationRows(1);
  expect(buildConversationViews(rows)[0]?.title).toBe('聊天名称暂不可用');
  rows[0]!.name={value:'<img onerror="alert(1)">',freshness:'stale'};
  expect(buildConversationViews(rows)[0]).toMatchObject({title:'<img onerror="alert(1)">',nameFreshness:'stale'});
  expect(buildConversationViews([])).toEqual([]);
});
