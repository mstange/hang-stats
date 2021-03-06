var gHangs, gTotalTime = 0, gTotalCount = 0;
var gThread;
const kMaxRows = 50;

// The values are the down sampling rates for the various hang sizes.
const hangFiles = {
  "128_65536": 1,
};

function showProgressMessage(text) {
  let message = document.createElement("p");
  message.textContent = text
  let div = document.getElementById("progress");
  div.appendChild(message);
  return message;
}

function setProgressMessageVisibility(visible) {
  document.getElementById("progress").style = visible ? "" : "display: none;";
}

function promiseAnimationFrame() {
  return new Promise(resolve => window.requestAnimationFrame(() => {
    setTimeout(resolve, 0);
  }));
}
function updateProgressMessage(message, text) {
  message.textContent = text;
  return promiseAnimationFrame();
}

function getURLSearchParams() {
  return new URLSearchParams(document.location.hash.slice(1));
}

function setURLSearchParam(param, value) {
  let URLHash = getURLSearchParams();
  URLHash.set(param, value);
  document.location.hash = URLHash.toString();
}

var gdate, filterString;
function setDate(date) {
  if (gdate)
    return;
  gdate = date;
  document.getElementById("buildid").textContent = `from build ${date}`;
  updateTitle();
}

function updateTitle() {
  let title = ["BHR"];
  if (gdate)
    title.push(gdate);
  if (filterString)
    title.push(filterString);
  document.title = title.join(" - ");
}

const kJSFuncNameExp = /\.js|\.xul|^self-hosted:/;

const kJSInternalPrefixes = [
  "js::", "JS::",
  "static bool InternalCall",
  "static bool Interpret",
  "static bool js::",
  "bool js::",
  "static bool SetExistingProperty",
  "(unresolved)",
];
function escapeForRegExp(string) {
  const exp = /[[\]{}()*+?.\\^$|]/g;
  return string.replace(exp, "\\$&");
}
const kJSInternalFrameExp = new RegExp("^(?:" + kJSInternalPrefixes.map(escapeForRegExp).join("|") + ")");
var gBugSignatureExp;

function isMozLib(libName) {
  return ["xul", "XUL", "libxul.so", //"nss3", "libnss3.dylib",
          "mozglue", "libmozglue.so"].includes(libName);
}

function getHangFrames(thread, id) {
    let frames = [];
    let stack = thread.sampleTable.stack[id];
    let shouldRemovePrefix = true;

    while (stack) {
      let frameId = thread.stackTable.func[stack];
      let funcName = thread.stringArray[thread.funcTable.name[frameId]];
      // Stacks with nested event loops are confusing, stop walking the stack
      // as soon as we reach the event queue.
      if (funcName.startsWith("nsThread::ProcessNextEvent(bool"))
        break;
      let libName = thread.libs[thread.funcTable.lib[frameId]].name;
      
      // Leave only one non-Mozilla frame at the top of the stack.
      if (shouldRemovePrefix && isMozLib(libName) &&
          !funcName.includes("::InterposedNt")) {
        shouldRemovePrefix = false;
        if (frames.length > 1)
          for (let i = 0; i < frames.length - 1; ++i)
            frames[i].hidden = "Foreign code";
      }

      function isJSFuncName(n) {
        return kJSFuncNameExp.test(n);
      }
      if (!libName && isJSFuncName(funcName) && frames.length) {
        // We are on a JS frame, trim all the previous frames that are internal
        // to the JS engine.
        let i = frames.length - 1;
        while (i && kJSInternalFrameExp.test(frames[i].funcName))
          --i;
        if (frames[i]) {
          let f = frames[i];
          if ((!f.libName && isJSFuncName(f.funcName)) ||
              f.funcName.startsWith("static bool XPC_WN_"))
            for (let ii = i + 1; ii < frames.length; ++ii)
              frames[ii].hidden = "JS Engine Internal";
        }

        if (frames.length > 3 &&
            ["XPTC__InvokebyIndex", "NS_InvokeByIndex"].includes(frames[frames.length - 3].funcName) &&
            frames[frames.length - 2].funcName.startsWith("XPCWrappedNative::CallMethod(") &&
            frames[frames.length - 1].funcName.startsWith("static bool XPC_WN_"))
          for (let ii = frames.length - 3; ii < frames.length; ++ii)
            frames[ii].hidden = "JS Engine Internal";
      }
      
      frames.push({frameId, funcName, libName, hidden: ""});
      stack = thread.stackTable.prefix[stack];
    }
  return frames;
}

async function fetchBugs() {
  let message = showProgressMessage("Fetching list of known bugs...");

  let bugListRequest = await fetch("https://bugzilla.mozilla.org/rest/bug?include_fields=id,summary,status,whiteboard&bug_status=UNCONFIRMED&bug_status=NEW&bug_status=ASSIGNED&bug_status=REOPENED&f1=classification&field0-0-0=status_whiteboard&o1=notequals&type0-0-0=substring&v1=Graveyard&value0-0-0=[bhr%3A");
  let bugList = await bugListRequest.json();
  let bugsMap = new Map();
  let signatures = [];
  for (let bug of bugList.bugs) {
    let signature = bug.whiteboard.replace(/.*\[bhr:/, "").replace(/].*/, "");
    bugsMap.set(signature, {id: bug.id, status: bug.status, summary: bug.summary});
    signatures.push(escapeForRegExp(signature));
  }

  gBugSignatureExp = new RegExp(signatures.join("|"), "g");

  message.remove();
  return bugsMap;
};

async function fetchHangs(size) {
  let file = `hang_profile_${size}.json`;
  file = "TEST_hang_profile_128_65536__incremental_20191117.json";
  file = "hangs_main_current.json";
//  file = "hangs_main_20200927.json";

  let message = showProgressMessage(`Fetching ${file}...`);
  let url = `https://analysis-output.telemetry.mozilla.org/bhr/data/hang_aggregates/${file}`;
  if (window.location.protocol == "file:")
    url = "./" + file;
  let response = await fetch(url);
  await updateProgressMessage(message, `Parsing ${file}...`);
  let data = await response.json();
  await updateProgressMessage(message, `Processing ${file}...`);

  let thread;
  for (thread of data.threads)
    if (thread.name == "Gecko" && thread.processType == "default")
      break;
  let day = thread.dates[0];
  let date = day.date;
  setDate(date);
  let usageHours = data.usageHoursByDate[date] / hangFiles[size];

  let searchParams = getURLSearchParams();
  let onlyXulLeaf = searchParams.has("onlyXulLeaf");
  let skipKnownBugs = searchParams.has("skipKnownBugs");

  let hangs = [];
  let hangCount = day.sampleHangMs.length;
  let startTime = Date.now();
  for (let id = 0; id < hangCount; ++id) {
    if (Date.now() - startTime > 40) {
      await promiseAnimationFrame();
      startTime = Date.now();
    }

    let allFrames = getHangFrames(thread, id);
    if (onlyXulLeaf && allFrames.length &&
        !isMozLib(allFrames[0].libName)) {
      continue;
    }

    let frames = allFrames.filter(f => !f.hidden);
    if (skipKnownBugs &&
        frames.some(frame => !!frame.funcName.match(gBugSignatureExp))) {
      continue;
    }

    hangs.push({duration: Math.round(day.sampleHangMs[id] * usageHours),
                count: Math.round(day.sampleHangCount[id] * usageHours),
                id,
                frames,
                frameIds: frames.map(f => f.frameId)});
  }

  message.remove();
  return {thread, hangs};
}

function formatTime(time) {
  if (time > 1000)
    return Math.round(time / 1000);
  return time / 1000;
}

var gFramesToFilter;

async function displayHangs(hangs, filterString, message) {
  let tbody = document.getElementById("tbody");
  while (tbody.firstChild)
    tbody.firstChild.remove();

  if (filterString) {
    setProgressMessageVisibility(true);
    await updateProgressMessage(message, "Filtering...");

    if (!gFramesToFilter) {
      gFramesToFilter = new Set();
      for (let hang of hangs) {
        for (let frameId of hang.frameIds) {
          gFramesToFilter.add(frameId);
        }
      }
    }

    let filterFun = value => value.includes(filterString);
    // Make the filter case insensitive if the filter string is all lower case.
    if (filterString.toLowerCase() == filterString) {
      filterFun = value => value.toLowerCase().includes(filterString);
    }

    let filteredFrames = new Set();
    let funcName = frameId => gThread.stringArray[gThread.funcTable.name[frameId]];
    let libName = frameId => gThread.libs[gThread.funcTable.lib[frameId]].name;
    for (let f of gFramesToFilter) {
      if (filterFun(funcName(f)) || filterFun(libName(f))) {
        filteredFrames.add(f);
      }
    }
    let startTime = Date.now();
    let filteredHangs = [];
    for (let hang of hangs) {
      if (Date.now() - startTime > 40) {
        await promiseAnimationFrame();
        if (document.getElementById("filter").value != filterString) {
          return;
        }
        startTime = Date.now();
      }
      if (hang.frameIds.some(f => filteredFrames.has(f))) {
        filteredHangs.push(hang);
      }
    }
    hangs = filteredHangs;
  }
  setProgressMessageVisibility(false);

  let count = 0;
  let totalCount = 0, totalTime = 0;
  function setTimeTitle(elt, time) {
    let percent = Math.round(time / gTotalTime * 10000) / 100;
    if (percent > 0)
      percent = percent.toLocaleString();
    else
      percent = "< " + (0.01).toLocaleString();
    percent += "% of total hang time";
    const kHourInMs = 3600000;
    if (time > kHourInMs)
      elt.title = `${(Math.round(time / kHourInMs * 10) / 10).toLocaleString()}h - ${percent}`;
    else
      elt.title = percent;
  }
  for (let hang of hangs) {
    let tr = document.createElement("tr");

    let td = document.createElement("td");
    td.textContent = ++count;
    tr.appendChild(td);

    td = document.createElement("td");
    td.textContent = formatTime(hang.duration).toLocaleString();
    setTimeTitle(td, hang.duration);
    tr.appendChild(td);
    totalTime += hang.duration;

    td = document.createElement("td");
    td.textContent = hang.count.toLocaleString();
    tr.appendChild(td);
    totalCount += hang.count;

    td = document.createElement("td");
    let frames = getHangFrames(gThread, hang.id);
    if (frames.length) {
      let frameId = 0;
      while (frames[frameId] && frames[frameId].hidden)
        ++frameId;
      if (!frames[frameId])
        console.log(hang);
      let {funcName, libName} = frames[frameId];
      td.textContent = `${funcName} ${libName}`;
    } else {
      td.textContent = "(empty stack)";
    }
    if (hang.knownBug) {
      let {id, status, summary} = hang.knownBug;
      td.innerHTML = `<a title="${status} - ${summary}" href="https://bugzilla.mozilla.org/show_bug.cgi?id=${id}">Bug ${id}</a> - ${summary}`;
    }
    tr.hang = hang;
    tr.frames = frames;
    tr.appendChild(td);

    tbody.appendChild(tr);

    if (count == kMaxRows) {
      for (let i = count; i < hangs.length; ++i) {
        totalTime += hangs[i].duration;
        totalCount += hangs[i].count;
      }

      tr = document.createElement("tr");
      tr.id = "footer";

      td = document.createElement("td");
      td.textContent = "Total";
      tr.appendChild(td);
      
      td = document.createElement("td");
      td.textContent = formatTime(totalTime).toLocaleString();
      setTimeTitle(td, totalTime);
      tr.appendChild(td);

      td = document.createElement("td");
      td.textContent = totalCount.toLocaleString();
      tr.appendChild(td);

      td = document.createElement("td");
      td.textContent = `And ${(hangs.length - count).toLocaleString()} other stacks...`;

      tr.appendChild(td);
      tbody.appendChild(tr);
      break;
    }
  }
  if (!count) {
    let tr = document.createElement("tr");

    let td = document.createElement("td");
    td.textContent = `No hang matching filter`;
    td.setAttribute("colspan", "4");

    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  let rowId = parseInt(getURLSearchParams().get("row"));
  let row;
  for (row = tbody.firstChild; rowId && row; --rowId)
    row = row.nextSibling;
  setSelectedRow(row);
  row.scrollIntoView();
}

let gSelectedRow;
function setSelectedRow(row) {
  if (gSelectedRow) {
    gSelectedRow.removeAttribute("selected");
  }
  let div = document.getElementById("stack");
  if (row && row.hang) {
    row.setAttribute("selected", "true");
    gSelectedRow = row;
    let escape = s => s.replace(/&/g, "&amp;")
                       .replace(/</g, "&lt;")
                       .replace(/>/g, "&gt;");
    div.innerHTML = `<ul>${
      row.frames.map(f =>
        (f.hidden ? `<li class="hidden-frame" title="${f.hidden}">`
                  : "<li>") +
        `${escape(f.funcName)} ${escape(f.libName)}</li>`)
         .join('')
    }</ul>`;
    let rowId = 0;
    for (let r = row.previousSibling; r; r = r.previousSibling) {
      ++rowId;
    }
    setURLSearchParam("row", rowId);
  } else if (gSelectedRow) {
    gSelectedRow = null;
    div.innerHTML = "";
    setURLSearchParam("row", "");
  }
}

window.onload = async function() {
  let searchParams = getURLSearchParams();
  filterString = searchParams.get("filter");
  let filterInput = document.getElementById("filter");
  if (filterString)
    filterInput.value = filterString;

  let bugsPromise = fetchBugs();
  let bugs = await bugsPromise;

  let allHangs = await Promise.all(Object.keys(hangFiles).map(fetchHangs));

  if (searchParams.has("showFrames")) {
    let frameUseCount;

    let startTime = Date.now();
    for (let {hangs: hangsArray, thread} of allHangs) {
      gThread = thread;
      frameUseCount = new Array(gThread.funcTable.length);
      for (var i = 0; i < gThread.funcTable.length; ++i) {
        frameUseCount[i] = {id: i, duration: 0, count: 0};
      }

      for (let hang of hangsArray) {
        if (Date.now() - startTime > 40) {
          await promiseAnimationFrame();
          startTime = Date.now();
        }

        let frameSet = new Set();
        for (let frameId of hang.frameIds) {
          // Avoid counting multiple times frames that appear multiple times
          // in the stack.
          if (frameSet.has(frameId))
            continue;
          frameSet.add(frameId);

          let frame = frameUseCount[frameId];
          frame.duration += hang.duration;
          frame.count += hang.count;
        }
      }

      frameUseCount.sort((a, b) => b.duration - a.duration);

      let tbody = document.getElementById("tbody");
      for (let i = 0; i < 1000; ++i) {
        let frame = frameUseCount[i];
        let funcName = gThread.stringArray[gThread.funcTable.name[frame.id]];
        let libName = gThread.libs[gThread.funcTable.lib[frame.id]].name;
        let duration = formatTime(frame.duration).toLocaleString();

        let tr = document.createElement("tr");

        let td = document.createElement("td");
        td.textContent = i;
        tr.appendChild(td);

        td = document.createElement("td");
        td.textContent = duration;
        tr.appendChild(td);

        td = document.createElement("td");
        td.textContent = frame.count.toLocaleString();
        tr.appendChild(td);

        td = document.createElement("td");
        td.textContent = `${funcName} ${libName}`;
        tr.appendChild(td);

        tbody.appendChild(tr);
      }
      document.getElementById("stackTitle").innerHTML = "Main thread hang frames from build " + gdate;
      document.getElementById("stack").remove();
      setProgressMessageVisibility(false);
      return;
    }
  }

  let message = showProgressMessage("Merging...");
  await promiseAnimationFrame();

  gHangs = [];
  let hangsMap = new Map();
  let startTime = Date.now();
  for (let {hangs: hangsArray, thread} of allHangs) {
    gThread = thread;
    for (let hang of hangsArray) {
      if (Date.now() - startTime > 40) {
        await promiseAnimationFrame();
        startTime = Date.now();
      }

      // De-duplicate hangs that have identical processed stacks.
      let stack = hang.frameIds.toString();
      if (hangsMap.has(stack)) {
        let existingHang = hangsMap.get(stack);
        existingHang.duration += hang.duration;
        existingHang.count += hang.count;
        continue;
      }

      // De-duplicate hangs for the same known bug.
      let signature;
      for (let frame of hang.frames) {
        signature = frame.funcName.match(gBugSignatureExp);
        if (signature)
          break;
      }
      if (signature) {
        let bug = bugs.get(signature[0]);
        if (bug.hang) {
          bug.hang.duration += hang.duration;
          bug.hang.count += hang.count;
          continue;
        }
        hang.knownBug = bug;
        bug.hang = hang;
      }
      // This hang is not in our merged list yet, add it.
      hang.frames = undefined;
      gHangs.push(hang);
      hangsMap.set(stack, hang);
    }
  }

  await updateProgressMessage(message, "Sorting...");
  gHangs.sort((a, b) => b.duration - a.duration);
  for (let hang of gHangs) {
    gTotalTime += hang.duration;
    gTotalCount += hang.count;
  }

  await displayHangs(gHangs, filterString, message);

  setProgressMessageVisibility(false);

  filterInput.addEventListener("input", event => {
    filterString = event.target.value;
    setURLSearchParam("filter", filterString);
    updateTitle();
    displayHangs(gHangs, filterString, message);
  });

  let tbody = document.getElementById("tbody");
  tbody.addEventListener("click", event => {
    // Handle selection changes
    let row = event.target.parentNode;
    setSelectedRow(row);
  });

  document.addEventListener("keydown", event => {
    if (event.target != document.querySelector("body") &&
        event.target != document.querySelector("html"))
      return;

    // Handle selection changes
    if (event.key == "ArrowDown") {
      if (!gSelectedRow)
        setSelectedRow(document.querySelector("tbody > tr"));
      else if (gSelectedRow.nextSibling &&
               !gSelectedRow.nextSibling.id) // avoid selecting the footer.
        setSelectedRow(gSelectedRow.nextSibling);
      event.preventDefault();
      gSelectedRow.scrollIntoView();
    }

    if (event.key == "ArrowUp") {
      if (gSelectedRow && gSelectedRow.previousSibling)
        setSelectedRow(gSelectedRow.previousSibling);
      event.preventDefault();
      gSelectedRow.scrollIntoView();
    }
  });
}
