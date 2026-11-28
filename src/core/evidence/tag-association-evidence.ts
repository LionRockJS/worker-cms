import type { AppContext } from '../http/context';
import type { ContainerKind } from '../db/data-classes';
import { json, type Row } from '../db/bounded-mutation';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { pageSnapshot, PAGE_LINK } from '../pages/page-snapshot';
import { beginAuditedMutation, type MutationPlan } from './audited-mutation';

type Change = {action:'add';pageId:number;tagId:number}|{action:'remove';id:number};
export class PageTagEvidenceUnavailableError extends Error { constructor(){super('Page tag change unavailable');} }

/** Host HTTP associations only. A missing add target returns null; a missing
 * removal is a guarded no-op. No publication, history or hook effect is added. */
export async function mutateHostPageTag(c:AppContext,change:Change):Promise<{id:number;created:boolean}|null> {
  assertRegulatedWritesAllowed(c.env);
  const input=change.action==='add'?[change.pageId,change.tagId]:[change.id];
  let result:{id:number;created:boolean}|null=null;
  const mutation=await beginAuditedMutation(c,{
    permission:'self',
    classify:['pages','page_tags','tags','taxonomies'].map(t=>['table',t] as [ContainerKind,string]),
    snapshot:{},
    unavailable:()=>new PageTagEvidenceUnavailableError(),
  });
  await mutation.commit(async(_rows,tools):Promise<MutationPlan|null>=>{
    if(input.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid association selection');
    let selected:Row|undefined;
    if(change.action==='remove'){
      // The page is the logged read; the selected link only names it.
      const [rows]=await tools.snapshot([{table:'page_tags',fields:PAGE_LINK,where:'id=?',args:[change.id],read:null}]);
      if(!rows.length){result={id:change.id,created:false};return null;}
      selected=rows[0] as Row;
    }
    const pageId=change.action==='add'?change.pageId:Number(selected!.page_id);
    if(!Number.isSafeInteger(pageId)||pageId<=0)throw new Error('Association owner unavailable');
    const snap=await tools.source(pageSnapshot(pageId,{readAction:'page.tag-association-read',extraTagIds:change.action==='add'?[change.tagId]:[]}));
    if(snap===null){if(change.action==='remove')throw new Error('Association owner unavailable');return null;}
    if(snap==='denied')return null;
    const {page,links,tags}=snap;
    // Refuse dangling new targets; legacy unrelated dangling links are preserved.
    if(change.action==='add'&&!tags.some(t=>t.id===change.tagId))return null;
    const existing=change.action==='add'?links.find(l=>l.tag_id===change.tagId):undefined;
    if(existing){result={id:Number(existing.id),created:false};return null;}
    const clock=await tools.clock();
    let affected:Row;
    if(change.action==='add') {
      if(links.length>=5000)throw new Error('Association manifest requires review');
      affected={id:await snap.allocateLinkId(),uuid:crypto.randomUUID(),created_at:clock.now,updated_at:clock.now,page_id:pageId,tag_id:change.tagId,weight:5};
    } else affected=selected!;
    const finalLinks=change.action==='add'?[...links,affected]:links.filter(l=>l.id!==affected.id);
    const detail={fields:['tags'],page:{id:page.id,uuid:page.uuid},association:affected,links_before:links,links_after:finalLinks};json(detail);
    result={id:Number(affected.id),created:change.action==='add'};
    return {
      writes:[change.action==='add'
        ?{sql:`INSERT INTO page_tags(${PAGE_LINK.join(',')}) VALUES (${PAGE_LINK.map(()=>'?').join(',')})`,args:PAGE_LINK.map(f=>affected[f])}
        :{sql:'DELETE FROM page_tags WHERE id=?',args:[affected.id]},
        {sql:'UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[pageId]}],
      evidence:{entry:{action:change.action==='add'?'page.tag-add':'page.tag-remove',entityType:'page',entityId:String(page.uuid),detail}},
      expect:since=>snap.expect({links:finalLinks,since,dataClass:tools.dataClass()}),
    };
  });
  return result;
}
