/* Folder enumeration is separate from transport: read every directory page, including empty directories. */
(function (global) {
  "use strict";
  const LIMIT=10000;
  function validatePath(value) {
    if (typeof value !== "string" || !value || value.length>2048) throw new Error("保存路径无效。");
    for (const part of value.split("/")) {
      if (!part || part === "." || part === ".." || part.length>255 || /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part) || /^\.bridge-part-/i.test(part)) throw new Error("文件或文件夹名称不适合 NAS，请修改名称后重试。");
    }
    return value;
  }
  function finish(files, directories, root, folder, picker=false) {
    if (files.length+directories.length>LIMIT) throw new Error("一次最多上传 10000 个文件和文件夹，请分批选择。");
    const names=new Set(), dirs=[...new Set(directories)];
    for (const path of dirs) {
      validatePath(path);
      const key=path.toLowerCase();
      if (names.has(key)) throw new Error("目录内有仅大小写不同的同名项目，NAS 无法同时保存。");
      names.add(key);
    }
    for (const item of files) {
      if (folder) validatePath(item.path);
      const key=item.path.toLowerCase();
      if (names.has(key)) throw new Error("目录内有同名或仅大小写不同的项目，NAS 无法同时保存。");
      names.add(key);
    }
    if (!folder && (!files.length || !files[0].file.size)) throw new Error("没有读取到文件内容（0 B），请通过“选择文件”重新选择。");
    return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),directories:dirs.sort(),root,folder,picker,total:files.reduce((n,item)=>n+item.file.size,0)};
  }
  function fromPicker(files, folder=false) {
    if (!files.length) throw new Error("没有选到文件；若是空文件夹，请直接拖入。");
    if (!folder && files.length!==1) throw new Error("请选择一个文件或一个文件夹。");
    const directories=new Set();
    const entries=files.map(file=>({file,path:folder ? file.webkitRelativePath : file.name}));
    const root=folder ? entries[0].path.split("/")[0] : files[0].name;
    if (folder) {
      for (const item of entries) {
        if (!item.path || !item.path.startsWith(root+"/")) throw new Error("无法读取文件夹结构，请重新选择。");
        const parts=item.path.split("/");
        for (let i=1;i<parts.length;i++) directories.add(parts.slice(0,i).join("/"));
      }
    }
    return finish(entries,[...directories],root,folder,folder);
  }
  async function fromDrop(data, cancelled, onProgress) {
    // Browser drag data must be captured before the first await.
    const items=Array.from(data.items || []).filter(item=>item.kind==="file");
    const fallback=Array.from(data.files || []);
    const entries=items.map(item=>item.webkitGetAsEntry ? item.webkitGetAsEntry() : null);
    if (!entries.length || entries.some(entry=>!entry)) return fromPicker(fallback);
    if (entries.length!==1) throw new Error("请选择一个文件或一个文件夹。");
    const first=entries[0], files=[], directories=[], stack=[{entry:first,path:first.name}];
    while (stack.length) {
      if (cancelled()) throw new Error("已停止读取文件夹。");
      const {entry,path}=stack.pop();
      validatePath(path);
      if (entry.isDirectory) {
        directories.push(path);
        const reader=entry.createReader();
        // Chromium may return only 100 entries at a time. Continue until the empty page.
        while (true) {
          if (cancelled()) throw new Error("已停止读取文件夹。");
          const children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
          if (!children.length) break;
          for (const child of children) stack.push({entry:child,path:path+"/"+child.name});
          if (stack.length+files.length+directories.length>LIMIT) throw new Error("一次最多上传 10000 个文件和文件夹，请分批选择。");
        }
      } else if (entry.isFile) {
        const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));
        files.push({file,path});
      } else throw new Error("拖入的项目不是普通文件或文件夹。");
      if (cancelled()) throw new Error("已停止读取文件夹。");
      if (files.length+directories.length>LIMIT) throw new Error("一次最多上传 10000 个文件和文件夹，请分批选择。");
      onProgress(files.length,directories.length);
    }
    return finish(files,directories,first.name,!!first.isDirectory);
  }
  global.FlitFancyBridgeFiles={fromPicker,fromDrop,validatePath};
})(window);
