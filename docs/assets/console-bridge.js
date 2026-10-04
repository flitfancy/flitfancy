/* 全界之桥：复用控制台会话，只负责选择文件与显示传输过程。 */
(function (global) {
  "use strict";
  const active = task => task && (["receiving","queued","sending","verifying","testing"].includes(task.state) || task.retryable);
  const inFlight = task => task && ["queued","sending","verifying","testing"].includes(task.state);
  const sizeText = value => {
    let n = Number(value) || 0, i = 0;
    const units = ["B","KB","MB","GB"];
    while (n >= 1024 && i < units.length-1) { n/=1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };
  function create(opts) {
    const root = opts.query('[data-role="bridge-panel"]');
    const field = name => root.querySelector('[data-bridge="'+name+'"]');
    const canUse = () => opts.isServerOnline() && opts.isAdmin();
    let config = null, task = null, file = null, busy = false, loading = false, generation = 0, pause = false, started = false, selectionVersion = 0, batch = null, scanning = false;
    const post = (route, data) => opts.request('/api/bridge/'+route, {method:"POST", body:JSON.stringify(data || {})});
    const valid = epoch => epoch === generation && canUse();
    const note = message => { field("message").textContent = message || ""; };
    const wait = opts.wait || (() => new Promise(resolve => setTimeout(resolve,700)));
    let configReadAt = 0;
    const refreshJob = opts.scheduler ? opts.scheduler.register({
      id: 'bridge-status', label: '全界之桥', page: 'console', interval: 5000,
      requiresAuth: true, hidden: 'pause', enabled: () => canUse() && !busy && !scanning,
      disabledReason: () => busy || scanning ? '传输任务自行更新进度' : '等待登录', run: poll,
    }) : null;
    function canRenameBatch() { return batch && !batch.completed.size && batch.adopt===null && task?.kind==="directories" && task.state==="failed"; }
    function batchFinished() { return batch && batch.dirsDone && batch.completed.size === batch.files.length; }
    function markCompleted(index) {
      if (!batch || batch.completed.has(index)) return;
      batch.completed.add(index);batch.completedBytes+=batch.files[index].file.size;
    }
    function recordBatchSuccess() {
      if (!batch || task?.kind!=="batch" || batch.verifiedTask!==task.id || !Array.isArray(batch.adopt)) return;
      task.files.forEach((item,index)=>{if(item.state==="succeeded") markCompleted(batch.adopt[index]);});
    }
    function renderBatch() {
      field("batch").hidden=!batch;
      if (!batch) return;
      const completed=batch.completed.size;
      field("batch-summary").textContent=completed+" / "+batch.files.length+" 个文件 · "+sizeText(batch.completedBytes)+" / "+sizeText(batch.total);
      field("batch-progress").value=batch.total ? batch.completedBytes/batch.total : (batchFinished() ? 1 : 0);
      field("batch-detail").textContent=batchFinished() ? "文件夹已全部保存并校验" : "文件夹上传期间请保持网页打开";
    }
    function controls() {
      const locked = active(task), working=busy || scanning;
      const batchLocked=batch && batch.started && !batchFinished();
      field("choose").disabled = !!(working || !config?.configured || batchLocked || (locked && task.state !== "receiving" && !task.retryable));
      field("choose-folder").disabled=field("choose").disabled;
      field("path").disabled = !!(working || locked || (batchLocked && !canRenameBatch()));
      field("send").disabled = !!(working || !config?.configured || (!file && !batch && !task?.retryable) || inFlight(task));
      field("send").textContent = batch ? (batchFinished() ? "已全部完成" : batch.started ? "继续上传文件夹" : "传入 NAS") : task?.retryable ? "重试传入 NAS" : task?.state === "receiving" ? "继续上传" : "传入 NAS";
      if (batchFinished()) field("send").disabled=true;
      field("test").disabled = !!(working || locked || batchLocked || !config?.configured);
      field("cancel").hidden = !locked && !batchLocked;
      field("cancel").disabled = !!(working || inFlight(task));
      field("pause").hidden = !working;
      field("pause").disabled = pause;
      renderBatch();
    }

    function renderTask() {
      field("job").hidden = !task;
      if (!task) return;
      recordBatchSuccess();
      const names = {receiving:"正在接收文件",queued:"等待传入 NAS",sending:"正在传入 NAS",verifying:"正在核对文件",testing:"正在测试连接",succeeded:"已完成",failed:"未完成",cancelled:"已取消",expired:"已过期"};
      field("job-name").textContent = task.kind === "connection" ? "NAS 连接测试" : task.kind === "directories" ? "准备文件夹结构" : task.kind === "batch" ? task.folder_root+" · "+task.file_count+" 个文件" : task.path;
      field("phase").textContent = names[task.state] || task.state;
      const done = task.state === "succeeded";
      field("receive").value = task.size ? task.received_bytes/task.size : (done ? 1 : 0);
      field("store").value = task.size ? task.sent_bytes/task.size : (done ? 1 : 0);
      field("receive-text").textContent = sizeText(task.received_bytes)+" / "+sizeText(task.size);
      field("store-text").textContent = done ? "校验通过" : sizeText(task.sent_bytes)+" / "+sizeText(task.size);
      field("meters").hidden = !["transfer","batch"].includes(task.kind);
      renderBatch();
      if (batch && !task.error) {
        note(batchFinished() ? "文件夹已全部存入 NAS，所有文件校验通过。" : "文件夹上传期间请保持网页打开，后续文件会依次发送。");
        renderBatch(); return;
      }
      if (task.error) note(task.error);
      else if (done) note(task.kind === "connection" ? "NAS 连接正常，可以传文件了。" : "文件已存入 NAS，完整性校验通过。");
      else if (["queued","sending","verifying"].includes(task.state)) note("电脑后台正在继续传输，现在可以关闭网页。");
      else if (task.state === "receiving" && !busy) note(task.kind === "batch"
        ? "重新选择原文件夹即可继续这个批次，或取消本次任务。"
        : file ? "文件仍在电脑暂存，可以继续上传。" : "重新选择同一文件即可继续上传，或取消本次任务。");
    }
    function clearPrivate() {
      generation++; selectionVersion++; pause=true; busy=false; loading=false; file=null; task=null; config=null; batch=null; scanning=false;
      configReadAt=0;
      field("body").hidden=true; field("locked").hidden=false;
      field("file").value=""; field("folder").value=""; field("path").value="";
      for (const name of ["destination","selected","job-name","message","phase","receive-text","store-text"]) field(name).textContent="";
      field("job").hidden=true;
      field("locked").textContent = opts.isServerOnline() ? "再次点击上方“控制台”登录后，就能把文件传回 NAS。" : "在管理控制台登录后使用全界之桥。";
      controls();
    }
    function errorMessage(error) {
      return error.status === 404 ? "后端尚未加载桥接口，请重启后端后再试。" : (error.message || "连接暂时中断，请重试。");
    }
    function refresh() { return refreshJob ? refreshJob.refresh() : poll(); }
    async function poll() {
      if (!canUse()) { clearPrivate(); return {skipped:true,reason:'auth'}; }
      if (loading || busy || scanning) return {skipped:true,reason:'busy'};
      const epoch=generation; loading=true;
      field("body").hidden=false; field("locked").hidden=true;
      try {
        const readConfig=!config || Date.now()-configReadAt>=60000;
        const [settings, state] = await Promise.all([readConfig ? opts.request('/api/bridge/config') : Promise.resolve(config),opts.request('/api/bridge/status')]);
        if (!valid(epoch) || busy) return {skipped:true};
        config=settings;
        if (readConfig) configReadAt=Date.now();
        field("destination").textContent = config.configured ? "NAS · "+config.root : "尚未配置 NAS 通道";
        if (batch) {
          if (task) task=(state.tasks || []).find(item=>item.id===task.id) || task;
        } else {
          const tasks=state.tasks || [];
          // Recover unfinished work, or update a job already shown in this session.
          // Backend history is not a current transfer when opening the page again.
          task=tasks.find(active) || (task ? tasks.find(item=>item.id===task.id) : null) || null;
        }
        if (!batch && active(task) && ["transfer","batch"].includes(task.kind)) field("path").value=task.path;
        renderTask(); controls();
        if (!config.configured) note("请先完成电脑端 NAS 连接配置。");
        return {ok:true};
      } catch (error) {
        if (!canUse()) { clearPrivate(); return {skipped:true,reason:'auth'}; }
        if (!valid(epoch)) return {skipped:true};
        if (valid(epoch)) { config=null; note(errorMessage(error)); controls(); }
        return {ok:false,status:error.status};
      } finally { if (epoch === generation) loading=false; }
    }
    async function action(work) {
      if (busy || scanning || !canUse()) return;
      const epoch=++generation; busy=true; loading=false; pause=false; controls(); note("");
      try { await work(epoch); }
      catch (error) { if (valid(epoch)) note(errorMessage(error)); }
      finally {
        if (epoch === generation) { busy=false; controls(); }
        if (!canUse()) clearPrivate();
      }
    }
    function rejectSelection(message) {
      selectionVersion++; file=null; batch=null;
      field("file").value="";
      field("selected").textContent="";
      if (!active(task)) field("path").value="";
      note(message); controls();
    }
    function applySelection(selected) {
      if (selected.files.some(item=>item.file.size>config.max_file_bytes)) throw new Error("其中有文件超过当前通道的大小限制。");
      if (selected.folder) {
        batch={...selected,started:false,dirsDone:false,completed:new Set(),completedBytes:0,adopt:null,target:null,verifiedTask:null};
        file=null;
        if (active(task)) {
          if (!["transfer","batch"].includes(task.kind) || !(task.state==="receiving" || task.retryable)) throw new Error("当前有未完成任务，请先处理或取消。");
          if (task.kind==="batch") {
            const positions=new Map(selected.files.map((item,index)=>[task.folder_root+item.path.slice(selected.root.length),index]));
            const indices=(task.files || []).map(item=>positions.get(item.path));
            if (!task.folder_root || !indices.length || new Set(indices).size!==indices.length || indices.some((index,i)=>index===undefined || selected.files[index].file.size!==task.files[i].size)) {
              batch=null;throw new Error("选择的文件夹与未完成任务不匹配，请先取消旧任务。");
            }
            batch.adopt=indices;batch.target=task.folder_root;
          } else {
            const matches=selected.files.map((item,index)=>({item,index,suffix:item.path.slice(selected.root.length)}))
              .filter(({item,suffix})=>(task.folder_root ? task.path===task.folder_root+suffix : task.path.endsWith(suffix)) && item.file.size===task.size);
            if (matches.length!==1) { batch=null; throw new Error("选择的文件夹与未完成任务不匹配，请先取消旧任务。"); }
            batch.adopt=matches[0].index;
            batch.target=task.path.slice(0,-matches[0].suffix.length);
          }
          batch.started=true;
        } else task=null;
        field("path").value=batch.target || selected.root;
        field("selected").textContent=selected.root+" · "+selected.files.length+" 个文件 · "+selected.directories.length+" 个文件夹 · "+sizeText(selected.total);
        note(selected.picker ? "已读取文件夹。若还需包含空文件夹，可直接拖入整个文件夹。" : "文件夹已读取，点击“传入 NAS”开始上传。");
      } else {
        if (active(task) && task.kind==="batch") throw new Error("当前是文件夹批次，请重新选择原文件夹，或先取消未完成任务。");
        batch=null;file=selected.files[0].file;
        field("selected").textContent=file.name+" · "+sizeText(file.size);
        if (!active(task)) {task=null;field("path").value=file.name;}
        note("");
      }
      field("job").hidden=!task;controls();
    }
    async function select(work) {
      if (!canUse() || busy || !config?.configured || (batch?.started && !batchFinished()) || (active(task) && task.state!=="receiving" && !task.retryable)) return;
      const epoch=generation, selection=++selectionVersion;
      scanning=true;pause=false;controls();note("正在读取文件和目录…");
      const cancelled=()=>!valid(epoch) || selection!==selectionVersion || pause;
      try {
        const selected=await work(cancelled,(files,dirs)=>{if (!cancelled()) note("正在读取 · "+files+" 个文件 · "+dirs+" 个文件夹");});
        if (!cancelled()) applySelection(selected);
      } catch (error) {
        if (!cancelled()) {rejectSelection(error.message || "无法读取文件夹，请重新选择。");scanning=false;}
      } finally {
        if (selection===selectionVersion) scanning=false;
        if (valid(epoch)) controls();
      }
    }
    async function uploadFile(epoch, target, reuse=false) {
      if (task?.state==="succeeded" && task.kind==="transfer" && task.path===target) return;
      if (task?.retryable) {
        const result=await post('transfers/commit',{id:task.id});
        if (valid(epoch)) { task=result; renderTask(); }
        return;
      }
      const selected=file;
      if (!selected) throw new Error("请先选择文件。");
      global.FlitFancyBridgeFiles.validatePath(target);
      note("正在准备文件…");
      const sha=await global.FlitFancyBridgeHash.fileHash(selected, bytes => {
        if (valid(epoch)) note("正在准备文件 · "+Math.round(bytes/Math.max(1,selected.size)*100)+"%");
      }, () => !valid(epoch) || pause);
      if (!valid(epoch) || pause) return;
      if (task?.state === "receiving") {
        if (task.size !== selected.size || task.sha256 !== sha) throw new Error("选择的文件与未完成任务不同，请重新选择或取消任务。");
      } else {
        const created=await post('transfers',{path:target,size:selected.size,sha256:sha,reuse_identical:reuse,...(batch ? {folder_root:batch.target} : {})});
        if (!valid(epoch)) return;
        task=created;
      }
      await sendPayload(epoch,selected);
    }
    async function sendPayload(epoch, selected) {
      const chunk=Math.min(config.chunk_bytes,256*1024);
      while (task.received_bytes < selected.size) {
        if (!valid(epoch) || pause) break;
        const offset=task.received_bytes;
        try {
          const result=await opts.request('/api/bridge/transfers/chunk?id='+encodeURIComponent(task.id)+'&offset='+offset, {
            method:"POST",headers:{"Content-Type":"application/octet-stream"},body:selected.slice(offset,offset+chunk),
          });
          if (!valid(epoch)) return;
          task=result;
        } catch (error) {
          // A response can be lost after the server accepted a chunk. Read its acknowledged offset.
          if (!valid(epoch)) return;
          const current=await opts.request('/api/bridge/transfers?id='+encodeURIComponent(task.id));
          if (!valid(epoch)) return;
          task=current; renderTask();
          throw new Error("上传已暂停，点击“继续上传”从已接收的位置继续。");
        }
        renderTask(); note("正在接收文件，请保持网页打开。");
      }
      if (!valid(epoch)) return;
      if (pause) { note("已暂停，稍后可以继续上传。"); return; }
      const result=await post('transfers/commit',{id:task.id});
      if (valid(epoch)) { task=result; renderTask(); }
    }
    function smallGroup(start) {
      if (!config.batch_upload) return null;
      const maxFiles=Math.min(config.batch_max_files || 32,32), maxBytes=Math.min(config.batch_max_bytes || 4194304,4194304), maxFile=Math.min(config.batch_max_file_bytes || 262144,262144);
      const indices=[];let bytes=0;
      for (let index=start;index<batch.files.length && indices.length<maxFiles;index++) {
        if (batch.completed.has(index)) continue;
        const size=batch.files[index].file.size;
        if (size>maxFile || bytes+size>maxBytes) break;
        indices.push(index);bytes+=size;
      }
      return indices.length ? indices : null;
    }
    function matchesManifest(candidate, manifest, rootPath) {
      return candidate?.kind==="batch" && candidate.folder_root===rootPath && Array.isArray(candidate.files) && candidate.files.length===manifest.length && manifest.every((item,index)=>["path","size","sha256"].every(key=>item[key]===candidate.files[index][key]));
    }
    async function uploadGroup(epoch, indices) {
      const currentBatch=batch, manifest=[];
      for (const index of indices) {
        const item=currentBatch.files[index],path=currentBatch.target+item.path.slice(currentBatch.root.length);
        global.FlitFancyBridgeFiles.validatePath(path);
        const sha256=await global.FlitFancyBridgeHash.fileHash(item.file,()=>{
          if(valid(epoch)) note("正在准备文件 · "+(manifest.length+1)+" / "+indices.length);
        },()=>!valid(epoch) || pause);
        if (!valid(epoch) || pause) return;
        manifest.push({path,size:item.file.size,sha256});
      }
      if (task) {
        if (!matchesManifest(task,manifest,currentBatch.target)) {
          throw new Error("选择的文件与未完成任务不同，请重新选择或取消任务。");
        }
      } else {
        let created;
        try {
          created=await post('batches',{folder_root:currentBatch.target,files:manifest});
        } catch (error) {
          if (!valid(epoch)) return;
          // Creation may have succeeded before its response was lost. Only adopt
          // the exact receiving manifest, never a different task or old success.
          let status;
          try {status=await opts.request('/api/bridge/status');} catch (_) {throw error;}
          if (!valid(epoch)) return;
          const matches=(status.tasks || []).filter(candidate=>candidate.state==="receiving" && matchesManifest(candidate,manifest,currentBatch.target));
          if (matches.length!==1) throw error;
          created=matches[0];
        }
        if (!valid(epoch)) return;
        task=created;
      }
      currentBatch.verifiedTask=task.id;renderTask();
      if (task.state==="succeeded") return;
      if (task.retryable) {
        const result=await post('transfers/commit',{id:task.id});
        if(valid(epoch)) {task=result;renderTask();}
        return;
      }
      await sendPayload(epoch,new Blob(indices.map(index=>currentBatch.files[index].file)));
    }
    async function waitForTask(epoch) {
      while (valid(epoch) && inFlight(task)) {
        if (pause) return false;
        // Await completion on the server: browser background timers can add a
        // full second per small file. Retain polling for an older backend.
        if (!config.task_wait) await wait();
        if (!valid(epoch)) return false;
        const current=await opts.request('/api/bridge/transfers?id='+encodeURIComponent(task.id)+(config.task_wait ? '&wait_ms=2000' : ''));
        if (!valid(epoch)) return false;
        task=current;renderTask();
      }
      if (!valid(epoch) || pause) return false;
      if (task?.state!=="succeeded") throw new Error(task?.error || "任务未完成，请重试。");
      return true;
    }
    async function upload(epoch) {
      if (!batch) return uploadFile(epoch,field("path").value.trim());
      if (!config.folder_upload) throw new Error("后端尚未加载文件夹接口，请运行重启脚本后刷新网页。");
      const currentBatch=batch;
      if (canRenameBatch()) {batch.started=false;task=null;}
      if (!batch.started) {
        const target=global.FlitFancyBridgeFiles.validatePath(field("path").value.trim());
        for (const path of [...batch.directories,...batch.files.map(item=>item.path)]) global.FlitFancyBridgeFiles.validatePath(target+path.slice(batch.root.length));
        batch.target=target;batch.started=true;
      }
      const targetFor=path=>currentBatch.target+path.slice(currentBatch.root.length);
      async function one(index) {
        const item=currentBatch.files[index];
        file=item.file;
        await uploadFile(epoch,targetFor(item.path),true);
        if (!await waitForTask(epoch)) return false;
        markCompleted(index);
        task=null;file=null;renderBatch();
        return true;
      }
      async function group(indices) {
        currentBatch.adopt=indices;
        await uploadGroup(epoch,indices);
        if (!await waitForTask(epoch)) return false;
        recordBatchSuccess();
        if (indices.some(index=>!currentBatch.completed.has(index))) throw new Error("批次完成记录不完整，请刷新后重试。");
        task=null;file=null;currentBatch.adopt=null;currentBatch.verifiedTask=null;renderBatch();
        return true;
      }
      if (batch.adopt!==null) {
        if (Array.isArray(batch.adopt)) {if (!await group(batch.adopt)) return;}
        else {
          if (!batch.completed.has(batch.adopt) && !await one(batch.adopt)) return;
          batch.adopt=null;
        }
      }
      if (!batch.dirsDone) {
        if (!task || task.kind!=="directories" || ["failed","cancelled","expired"].includes(task.state)) {
          const paths=batch.directories.map(targetFor);
          if (new Blob([JSON.stringify({paths})]).size>900000) throw new Error("目录列表过大，请分批上传。");
          const created=await post('directories',{paths});
          if (!valid(epoch)) return;
          task=created;renderTask();
        }
        if (!await waitForTask(epoch)) return;
        batch.dirsDone=true;task=null;
      }
      for (let index=0;index<batch.files.length;index++) {
        if (!valid(epoch) || pause) break;
        if (batch.completed.has(index)) continue;
        const indices=smallGroup(index);
        if (indices) {if (!await group(indices)) return;}
        else if (!await one(index)) return;
      }
      if (!valid(epoch)) return;
      renderBatch();field("job").hidden=!task;
      note(batchFinished() ? "文件夹已全部存入 NAS，所有文件校验通过。" : "队列已暂停，点击“继续上传文件夹”接着传。");
    }
    function start() {
      if (started) return;
      started=true;clearPrivate();
      field("choose").addEventListener("click",()=>{field("file").value="";field("file").click();});
      field("choose-folder").addEventListener("click",()=>{field("folder").value="";field("folder").click();});
      field("file").addEventListener("change",()=>select(()=>global.FlitFancyBridgeFiles.fromPicker(Array.from(field("file").files || []))));
      field("folder").addEventListener("change",()=>select(()=>global.FlitFancyBridgeFiles.fromPicker(Array.from(field("folder").files || []),true)));
      field("drop").addEventListener("dragover",event=>event.preventDefault());
      field("drop").addEventListener("drop",event=>{event.preventDefault();return select((cancelled,onProgress)=>global.FlitFancyBridgeFiles.fromDrop(event.dataTransfer,cancelled,onProgress));});
      field("send").addEventListener("click",()=>action(upload));
      field("pause").addEventListener("click",()=>{pause=true;if(scanning){selectionVersion++;scanning=false;note("已停止读取文件夹。");}controls();});
      field("refresh").addEventListener("click",refresh);
      field("test").addEventListener("click",()=>action(async epoch=>{
        const result=await post('test');if(valid(epoch)){task=result;renderTask();}
      }));
      field("cancel").addEventListener("click",()=>action(async epoch=>{
        if (task && (task.state==="receiving" || task.retryable)) {
          const result=await post('transfers/cancel',{id:task.id});
          if (!valid(epoch)) return;
          task=result;
        }
        batch=null;file=null;field("file").value="";field("folder").value="";field("selected").textContent="";
        renderTask();renderBatch();note("已取消剩余任务，NAS 中已完成的文件会保留。");
      }));
    }
    function dispose() { if (refreshJob) refreshJob.unregister(); clearPrivate(); }
    return {start,refresh,clearPrivate,dispose};
  }
  global.FlitFancyConsoleBridge={create};
})(window);
