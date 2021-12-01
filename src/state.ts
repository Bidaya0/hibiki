import * as mobx from "mobx";
import md5 from "md5";
import Axios from "axios";
import {sprintf} from "sprintf-js";
import {boundMethod} from 'autobind-decorator'
import {v4 as uuidv4} from 'uuid';
import {HibikiNode, ComponentType, LibraryType, HandlerPathObj, HibikiConfig, HibikiHandlerModule, RequestType, HibikiAction, TCFBlock, EventType, HandlerValType} from "./types";
import * as DataCtx from "./datactx";
import {isObject, textContent, SYM_PROXY, SYM_FLATTEN, nodeStr} from "./utils";
import {RtContext, HibikiError} from "./error";

import {parseHtml} from "./html-parser";

let VALID_METHODS = {"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true};

function eventBubbles(event : string) : boolean {
    if (event == "load") {
        return false;
    }
    if (event.startsWith("x")) {
        return false;
    }
    return true;
}

function unbox(data : any) : any {
    if (mobx.isBoxedObservable(data)) {
        return data.get();
    }
    return data;
}

type DataEnvironmentOpts = {
    componentRoot? : {[e : string] : any},
    description? : string,
    handlers? : Record<string, HandlerValType>,
    htmlContext? : string,
    eventBoundary? : string, // "soft" | "hard",
};

class DataEnvironment {
    parent : DataEnvironment | null;
    dbstate : HibikiState;
    data : any;
    specials : Record<string, any>;
    handlers : Record<string, HandlerValType>;
    onlySpecials : boolean;
    componentRoot : Record<string, any>;
    htmlContext : string;
    description : string;
    eventBoundary : "soft" | "hard";

    constructor(dbstate : HibikiState, data : any, opts? : DataEnvironmentOpts) {
        this.parent = null;
        this.dbstate = dbstate;
        this.data = data;
        this.specials = {};
        this.handlers = {};
        this.onlySpecials = false;
        this.eventBoundary = null;
        if (opts != null) {
            this.componentRoot = opts.componentRoot;
            this.description = opts.description;
            this.handlers = opts.handlers || {};
            this.htmlContext = opts.htmlContext;
            if (opts.eventBoundary == "soft" || opts.eventBoundary == "hard") {
                this.eventBoundary = opts.eventBoundary;
            }
        }
    }

    getHtmlContext() : string {
        if (this.htmlContext != null) {
            return this.htmlContext;
        }
        if (this.parent == null) {
            return "none";
        }
        return this.parent.getHtmlContext();
    }

    getFullHtmlContext() : string {
        let env : DataEnvironment = this;
        let rtn = "";
        while (env != null) {
            if (env.htmlContext != null && env.htmlContext != "<define-vars>") {
                if (rtn == "") {
                    rtn = env.htmlContext;
                }
                else {
                    if (env.htmlContext != "<root>") {
                        rtn = env.htmlContext + " | " + rtn;
                    }
                }
            }
            env = env.parent;
        }
        if (rtn == "") {
            return "<unknown>";
        }
        return rtn;
    }

    getRootDataEnv() : DataEnvironment {
        let rtn : DataEnvironment = this;
        while (rtn.parent != null) {
            rtn = rtn.parent;
        }
        return rtn;
    }

    resolveRoot(rootName : string, opts?: {caret? : number}) : any {
        opts = opts || {};
        if (opts.caret != null && opts.caret < 0 || opts.caret > 1) {
            throw "Invalid caret value, must be 0 or 1";
        }
        if (rootName == "global" || rootName == "data") {
            return unbox(this.dbstate.DataRoots["global"]);
        }
        if (rootName == "state") {
            return unbox(this.dbstate.DataRoots["state"]);
        }
        if (rootName == "local") {
            if (opts.caret) {
                let localstack = this.getLocalStack();
                if (localstack.length <= opts.caret) {
                    return null;
                }
                return localstack[opts.caret];
            }
            return this.data;
        }
        if (rootName == "null") {
            return null;
        }
        if (rootName == "nodedata") {
            return this.dbstate.NodeDataMap;
        }
        if (rootName == "context") {
            let ref : DataEnvironment = this;
            if (opts.caret) {
                for (let i=0; i<opts.caret && ref != null; i++) {
                    ref = ref.parent;
                }
            }
            if (ref == null) {
                return null;
            }
            return ref.getContextProxy();
        }
        if (rootName == "currentcontext") {
            let ref : DataEnvironment = this;
            if (opts.caret) {
                for (let i=0; i<opts.caret && ref != null; i++) {
                    ref = ref.parent;
                }
            }
            if (ref == null) {
                return null;
            }
            return ref.specials;
        }
        if (rootName == "localstack") {
            return this.getLocalStack();
        }
        if (rootName == "contextstack") {
            return this.getContextStack();
        }
        if (rootName == "c" || rootName == "component") {
            return this.getComponentRoot();
        }
        else {
            if (rootName in this.dbstate.DataRoots) {
                return unbox(this.dbstate.DataRoots[rootName]);
            }
            throw "Invalid root path";
        }
    }

    getContextProxy() : {[e : string] : any} {
        let self = this;
        let traps = {
            get: (obj : any, prop : (string | number | symbol)) : any => {
                if (prop == null) {
                    return null;
                }
                if (prop == SYM_PROXY) {
                    return true;
                }
                if (prop == SYM_FLATTEN) {
                    return self.getSquashedContext();
                }
                return self.getContextKey(prop.toString());
            },
            set: (obj : any, prop : string, value : any) : boolean => {
                if (prop == null) {
                    return true;
                }
                self.specials[prop] = value;
                return true;
            },
        };
        return new Proxy({}, traps);
    }

    getSquashedContext() : {[e : string] : any} {
        let stack = this.getContextStack();
        let rtn = {};
        for (let i=stack.length-1; i>=0; i--) {
            Object.assign(rtn, stack[i]);
        }
        return rtn;
    }

    printStack() {
        let jsonSpecials = DataCtx.JsonStringify(this.specials);
        let deType = "";
        if (this.eventBoundary == "hard") {
            deType = "--|";
        }
        else if (this.eventBoundary == "soft") {
            deType = "-*|";
        }
        else {
            deType = "  |";
        }
        if (this.parent != null) {
            this.parent.printStack();
        }
        let hkeysStr = Object.keys(this.handlers).join(",");
        let specialsStr = Object.keys(this.specials).map((v) => "@" + v).join(",");
        let stackStr = sprintf("%s %-30s | %-30s | %s", deType, this.htmlContext, specialsStr, hkeysStr);
        console.log(stackStr);
    }

    // always returns hard
    // returns soft if event == "*" or env.handlers[event] != null
    getEventBoundary(event : string) : DataEnvironment {
        let env : DataEnvironment = this;;
        while (env != null) {
            if (env.eventBoundary == "hard") {
                return env;
            }
            if (event != null && env.eventBoundary == "soft") {
                if (event == "*" || env.handlers[event] != null) {
                    return env;
                }
            }
            env = env.parent;
        }
        return env;
    }

    getParentEventBoundary(event : string) : DataEnvironment {
        let eb1 = this.getEventBoundary(event);
        if (eb1 == null || eb1.parent == null) {
            return null;
        }
        return eb1.parent.getEventBoundary(event);
    }

    fireEvent(event : EventType, rtctx : RtContext, throwErrors? : boolean) : Promise<any> {
        // if (event.event != "mount") {
        //     console.log("FIRE-EVENT", event.event, this.getFullHtmlContext());
        // }
        let env = this.getEventBoundary(event.event);
        if (env == null) {
            this.dbstate.unhandledEvent(event, rtctx);
            return null;
        }
        if (!(event.event in env.handlers)) {
            if (!event.bubble || env.parent == null) {
                return null;
            }
            return env.parent.fireEvent(event, rtctx);
        }
        let hval = env.handlers[event.event];
        let htmlContext = sprintf("event%s(%s)", (event.bubble ? "-bubble" : ""), event.event);
        let eventEnv = env.makeSpecialChildEnv(event.datacontext, {htmlContext: htmlContext});
        let tcfBlock : TCFBlock = {block: null};
        let ctxStr = sprintf("Parsing %s:%s.handler (in [[%s]])", nodeStr(hval.node), event.event, env.getFullHtmlContext());
        rtctx.pushContext(ctxStr, {handlerEnv: eventEnv, handlerName: event.event});
        tcfBlock.block = DataCtx.ParseBlockThrow(hval.handlerStr);
        rtctx.popContext();
        ctxStr = sprintf("Running %s:%s.handler (in [[%s]])", nodeStr(hval.node), event.event, env.getFullHtmlContext());
        rtctx.pushContext(ctxStr, {handlerEnv: eventEnv, handlerName: event.event});
        if (throwErrors) {
            return DataCtx.ExecuteBlockPThrow(tcfBlock.block, eventEnv, rtctx);
        }
        else {
            return DataCtx.ExecuteBlockP(tcfBlock, eventEnv, rtctx, false);;
        }
    }

    getContextKey(contextkey : string) : any {
        if (contextkey in this.specials) {
            return this.specials[contextkey];
        }
        if (this.parent == null) {
            return null;
        }
        return this.parent.getContextKey(contextkey);
    }

    makeLValue(path : string) : DataCtx.LValue {
        let lv = DataCtx.ParseLValuePath(path, this);
        return lv;
    }

    getComponentRoot() : {[e : string] : any} {
        if (this.componentRoot != null) {
            return this.componentRoot;
        }
        if (this.parent == null) {
            return null;
        }
        return this.parent.getComponentRoot();
    }

    getLocalStack() : any[] {
        let dataenv : DataEnvironment = this;
        let rtn = [];
        while (true) {
            if (dataenv == null) {
                break;
            }
            if (!dataenv.onlySpecials) {
                rtn.push(dataenv.data);
            }
            dataenv = dataenv.parent;
        }
        return rtn;
    }

    getContextStack() : any[] {
        let dataenv : DataEnvironment = this;
        let rtn = [];
        while (true) {
            if (dataenv == null) {
                break;
            }
            rtn.push(dataenv.specials);
            dataenv = dataenv.parent;
        }
        return rtn;
    }

    makeChildEnv(data : any, specials? : any, opts? : DataEnvironmentOpts) : DataEnvironment {
        specials = specials || {};
        let rtn = new DataEnvironment(this.dbstate, data, opts);
        rtn.parent = this;
        let copiedSpecials = Object.assign({}, specials || {});
        rtn.specials = copiedSpecials;
        return rtn;
    }

    makeSpecialChildEnv(specials : any, opts? : DataEnvironmentOpts) : DataEnvironment {
        let rtn = this.makeChildEnv(this.data, specials, opts);
        rtn.onlySpecials = true;
        return rtn;
    }

    resolvePath(path : string, keepMobx? : boolean) : any {
        let rtn = DataCtx.ResolvePath(path, this);
        if (!keepMobx) {
            rtn = DataCtx.demobx(rtn);
        }
        return rtn;
    }

    setDataPath(path : string, data : any) {
        DataCtx.SetPath(path, this, data);
    }

    evalExpr(expr : string, keepMobx? : boolean) : any {
        if (expr == null || expr == "") {
            return null;
        }
        let rtn = DataCtx.EvalSimpleExpr(expr, this);
        if (!keepMobx) {
            rtn = DataCtx.demobx(rtn);
        }
        return rtn;
    }
}

function DefaultCsrfHook() {
    let csrfToken = null;
    let csrfMwElem = document.querySelector('[name=csrfmiddlewaretoken]');
    if (csrfMwElem != null) {
        csrfToken = (csrfMwElem as any).value;
    }
    let csrfMetaElem = document.querySelector("meta[name=csrf-token]");
    if (csrfMetaElem != null) {
        csrfToken = (csrfMetaElem as any).content;
    }
    if (csrfToken != null) {
        return {
            "X-Csrf-Token": csrfToken,
            "X-CSRFToken": csrfToken,
        };
    }
}

class ComponentLibrary {
    libs : Record<string, LibraryType> = {};          // name -> library
    components : Record<string, ComponentType> = {};  // name -> component

    addLibrary(libObj : LibraryType) {
        this.libs[libObj.name] = libObj;
    }

    buildLib(libName : string, htmlobj : HibikiNode, clear : boolean) {
        if (this.libs[libName] == null || clear) {
            this.libs[libName] = {name: libName, components: {}};
        }
        let libObj = this.libs[libName];
        if (htmlobj == null || htmlobj.list == null) {
            return;
        }
        for (let h of htmlobj.list) {
            if (h.tag != "define-component") {
                continue;
            }
            if (!h.attrs || !h.attrs["name"]) {
                console.log("define-component tag without a name, skipping");
                continue;
            }
            let name = h.attrs["name"];
            if (libObj.components[name]) {
                console.log(sprintf("cannot redefine component %s/%s", libName, name));
                continue;
            }
            if (h.attrs.react) {
                libObj.components[name] = {componentType: "react-custom", reactimpl: mobx.observable.box(null)};
                continue;
            }
            libObj.components[name] = {componentType: "hibiki-html", node: h};
        }
    }

    importLib(libName : string, prefix : string) {
        let libObj = this.libs[libName];
        if (libObj == null) {
            console.log("ERROR invalid component library", libName);
            return;
        }
        for (let name in libObj.components) {
            if (name.startsWith("@")) {
                continue;
            }
            let newComp = libObj.components[name];
            let cpath = libName + ":" + name;
            let importName = (prefix == null ? "" : prefix + "-") + name;
            let origComp = this.components[importName];
            if (origComp != null && (origComp.libName != libName || origComp.name != name)) {
                console.log(sprintf("Conflicting import %s %s:%s (discarding %s:%s)", importName, origComp.libName, origComp.name, libName, name));
                continue;
            }
            this.components[importName] = {componentType: newComp.componentType, libName: libName, name: name, impl: newComp.impl, reactimpl: newComp.reactimpl, node: newComp.node};
        }
    }

    findComponent(tagName : string) : ComponentType {
        return this.components[tagName];
    }

    setLocalReactComponent(name : string, reactImpl : any) {
        let component : ComponentType = {
            componentType: "react-custom",
            libName: "local",
            name: name,
            reactimpl: mobx.observable.box(reactImpl),
        };
        let cname = "local-" + name;
        if (this.components[cname] == null) {
            this.components[cname] = component;
        }
        else {
            let ecomp = this.components[cname];
            if (ecomp.componentType != "react-custom" || ecomp.reactimpl.get() != null) {
                throw sprintf("Cannot redefine component %s (existing %s/%s)", cname, ecomp.libName, ecomp.name);
            }
            ecomp.reactimpl.set(reactImpl);
        }
    }
}

class FetchModule {
    dbstate : HibikiState;
    CsrfHook : () => Record<string, string> = DefaultCsrfHook;
    FetchInitHook : (url : URL, init : Record<string, any>) => void;

    constructor(state : HibikiState) {
        this.dbstate = state;
    }
    
    fetchConfig(url : URL, params : any, init : Record<string, any>) : any {
        init = init || {};
        init.headers = init.headers || new Headers();
        if (this.dbstate.FeClientId) {
            init.headers.set("X-Hibiki-FeClientId", this.dbstate.FeClientId);
        }
        if (this.CsrfHook != null) {
            let csrfHeaders = this.CsrfHook();
            if (csrfHeaders != null) {
                for (let h in csrfHeaders) {
                    init.headers.set(h, csrfHeaders[h]);
                }
            }
        }
        if (!("mode" in init)) {
            // init.mode = "cors";
        }
        if (this.FetchInitHook) {
            this.FetchInitHook(url, init);
        }
        return init;
    }
    
    callHandler(req : RequestType) : Promise<any> {
        let method = req.path.pathfrag;
        if (method == null) {
            throw sprintf("Invalid null method passed to /@fetch:[method]");
        }
        // console.log("call-fetch", req.path, req.data);
        method = method.toUpperCase();
        if (!VALID_METHODS[method]) {
            throw new Error(sprintf("Invalid method passed to /@fetch:[method]: '%s'", method));
        }
        let [urlStr, params, initParams] = (req.data ?? []);
        if (urlStr == null || typeof(urlStr) != "string") {
            throw new Error("Invalid call to /@fetch, first argument must be a string (the URL to fetch)");
        }
        let url : URL = null;
        try {
            url = new URL(urlStr);
        }
        catch (e) {
            throw sprintf("Invalid URL passed to fetch '%s': %s", urlStr, e.toString());
        }
        if (params != null && !isObject(params)) {
            throw sprintf("Invalid params passed to /@fetch for url '%s', params must be an object not an array", urlStr);
        }
        let headersObj = new Headers();
        initParams = initParams ?? {};
        if (initParams.headers != null && isObject(initParams.headers)) {
            for (let key in initParams.headers) {
                headersObj.set(key, initParams.headers[key]);
            }
        }
        initParams.headers = headersObj;
        initParams.method = method;
        if (params != null) {
            if (method == "GET" || method == "DELETE") {
                for (let key in params) {
                    let val = params[key];
                    if (val == null || typeof(val) == "function") {
                        continue;
                    }
                    if (typeof(val) == "string" || typeof(val) == "number") {
                        url.searchParams.set(key, val.toString());
                    }
                    else {
                        url.searchParams.set(key, JSON.stringify(val));
                    }
                }
            }
            else {
                initParams.headers.set("Content-Type", "application/json");
                initParams.body = JSON.stringify(params);
            }
        }
        initParams = this.fetchConfig(url, params, initParams);
        let p = fetch(url.toString(), initParams).then((resp) => {
            if (!resp.ok) {
                throw sprintf("Bad status code response from '%s': %d %s", req.data[0], resp.status, resp.statusText);
            }
            let contentType = resp.headers.get("Content-Type");
            if (contentType != null && contentType.startsWith("application/json")) {
                return resp.json();
            }
            else {
                let blobp = resp.blob();
                return blobp.then((blob) => {
                    return new Promise((resolve, _) => {
                        let reader = new FileReader();
                        reader.onloadend = () => {
                            let mimetype = blob.type;
                            let semiIdx = (reader.result as string).indexOf(";");
                            if (semiIdx == -1 || mimetype == null || mimetype == "") {
                                throw "Invalid BLOB returned from fetch, bad mimetype or encoding";
                            }
                            let dbblob = new DataCtx.HibikiBlob();
                            dbblob.mimetype = blob.type;
                            // extra 7 bytes for "base64," ... e.g. data:image/jpeg;base64,[base64data]
                            dbblob.data = (reader.result as string).substr(semiIdx+1+7);
                            resolve(dbblob);
                        };
                        reader.readAsDataURL(blob);
                    });
                });
            }
        });
        return p;
    }
}

class HibikiExtState {
    state : HibikiState;
    
    constructor(state : HibikiState) {
        this.state = state;
    }

    initialize(force : boolean) {
        this.state.initialize(force);
    }

    setHtml(html : string | HTMLElement) {
        let htmlObj = parseHtml(html);
        this.state.setHtml(htmlObj);
    }

    setData(path : string, data : any) {
        let dataenv = this.state.rootDataenv();
        dataenv.setDataPath(path, data);
    }

    getData(path : string) : any {
        let dataenv = this.state.rootDataenv();
        return dataenv.resolvePath(path, false);
    }

    setLocalReactComponent(name : string, reactImpl : any) {
        this.state.ComponentLibrary.setLocalReactComponent(name, reactImpl);
    }

    runActions(actions : HibikiAction[]) : any {
        return this.state.runActions(actions);
    }

    setHtmlPage(htmlPage : string) {
        this.state.setHtmlPage(htmlPage);
    }

    setInitCallback(fn : () => void) {
        this.state.setInitCallback(fn);
    }
}

class HibikiState {
    FeClientId : string = null;
    Ui : string = null;
    ErrorCallback : (HibikiError) => void;
    HtmlObj : mobx.IObservableValue<any> = mobx.observable.box(null, {name: "HtmlObj", deep: false});
    ComponentLibrary : ComponentLibrary;
    Initialized : mobx.IObservableValue<boolean> = mobx.observable.box(false, {name: "Initialized"});
    RenderVersion : mobx.IObservableValue<number> = mobx.observable.box(0, {name: "RenderVersion"});
    DataNodeStates = {};
    ScriptCache = {};
    PostScriptRunQueue : any[] = [];
    HasRendered = false;
    ScriptsLoaded : mobx.IObservableValue<boolean> = mobx.observable.box(false, {name: "ScriptsLoaded"});
    NodeDataMap : Map<string, mobx.IObservableValue<any>> = new Map();  // TODO clear on unmount
    ExtHtmlObj : mobx.ObservableMap<string,any> = mobx.observable.map({}, {name: "ExtHtmlObj", deep: false});
    Config : HibikiConfig = {};
    HtmlPage : mobx.IObservableValue<string> = mobx.observable.box("default", {name: "HtmlPage"});
    InitCallbacks : (() => void)[];
    
    Modules : Record<string, HibikiHandlerModule> = {};
    DataRoots : Record<string, mobx.IObservableValue<any>>;

    constructor() {
        this.DataRoots = {};
        this.DataRoots["global"] = mobx.observable.box({}, {name: "GlobalData"})
        this.DataRoots["state"] = mobx.observable.box({}, {name: "AppState"})
        this.ComponentLibrary = new ComponentLibrary();
        this.Modules["fetch"] = new FetchModule(this);
        this.InitCallbacks = [];
    }

    setInitCallback(fn : () => void) {
        if (this.Initialized.get()) {
            fn();
        }
        else {
            this.InitCallbacks.push(fn);
        }
    }

    @mobx.action
    setInitialized() {
        this.Initialized.set(true);
        for (let i=0; i<this.InitCallbacks.length; i++) {
            try {
                this.InitCallbacks[i]();
            }
            catch (e) {
                console.log("Hibiki Error running InitCallback", e);
            }
        }
    }

    initialize(force : boolean) {
        if (this.Initialized.get()) {
            console.log("Hibiki State is already initialized");
        }
        if (force || this.Config.initHandler == null) {
            this.setInitialized();
            return;
        }
        let rtctx = new RtContext();
        let p = this.initDataenv().fireEvent({event: "init", bubble: false, datacontext: {}}, rtctx, true);
        p.then(() => {
            this.setInitialized();
        }).catch((e) => {
            rtctx.pushErrorContext(e);
            let errObj = new HibikiError(e.toString(), e, rtctx);
            this.reportErrorObj(errObj);
        });
    }

    getExtState() : HibikiExtState {
        return new HibikiExtState(this);
    }

    @mobx.action setHtmlPage(htmlPage : string) {
        this.HtmlPage.set(htmlPage);
    }

    @mobx.action setConfig(config : HibikiConfig) {
        config = config ?? {};
        this.Config = config;
        if (config.errorCallback != null) {
            this.ErrorCallback = config.errorCallback;
        }
    }

    @mobx.action setGlobalData(globalData : any) {
        this.DataRoots["global"].set(globalData);
    }

    @mobx.action setHtml(htmlobj : HibikiNode) {
        this.HtmlObj.set(htmlobj);
        this.ComponentLibrary.buildLib("local", htmlobj, true);
        this.ComponentLibrary.importLib("local", "local");
    }

    allowUsageImg() : boolean {
        return !this.Config.noUsageImg;
    }

    allowWelcomeMessage() : boolean {
        return !this.Config.noWelcomeMessage;
    }

    unhandledEvent(event : EventType, rtctx : RtContext) {
        if (event.event == "error" && event.datacontext != null && event.datacontext.error != null) {
            this.reportErrorObj(event.datacontext.error);
        }
        else {
            console.log("unhandled event", event.event, event.datacontext, rtctx);
        }
    }

    rootDataenv() : DataEnvironment {
        let opts = {htmlContext: "<root>"};
        return new DataEnvironment(this, null, opts);
    }

    initDataenv() : DataEnvironment {
        let env = this.rootDataenv();
        if (this.Config.initHandler != null) {
            let opts = {eventBoundary: "hard", handlers: {}};
            opts.handlers["init"] = {
                handlerStr: this.Config.initHandler,
                node: {tag: "hibiki-root"},
            };
            env = env.makeChildEnv(null, null, opts);
        }
        return env;
    }

    @mobx.action fireScriptsLoaded() {
        let dataenv = this.rootDataenv();
        this.ScriptsLoaded.set(true);
        DataCtx.SetPath("$state.hibiki.scriptsloaded", dataenv, true);
        while (this.PostScriptRunQueue.length > 0) {
            let fn = this.PostScriptRunQueue.shift();
            try {
                fn();
            }
            catch (e) {
                console.log("ERROR in PostScriptRunQueue", e);
            }
        }
    }

    queuePostScriptRunFn(fn : any) {
        if (this.ScriptsLoaded.get()) {
            setTimeout(fn, 1);
            return;
        }
        this.PostScriptRunQueue.push(fn);
    }

    destroyPanel() {
        console.log("Destroy Hibiki State");
    }

    findCurrentPage() : HibikiNode {
        return this.findPage(this.HtmlPage.get());
    }

    findPage(pageName? : string) : HibikiNode {
        if (pageName == null || pageName == "") {
            pageName = "default";
        }
        let htmlobj = this.HtmlObj.get();
        if (htmlobj == null || htmlobj.list == null) {
            return null;
        }
        let starTag = null;
        let hasPages = false;
        for (let h of htmlobj.list) {
            if (h.tag != "page") {
                continue;
            }
            hasPages = true;
            let tagNameAttr = "default";
            if (h.attrs) {
                tagNameAttr = h.attrs["name"] ?? h.attrs["appname"] ?? "default";
            }
            if (tagNameAttr == pageName) {
                return h;
            }
            if (tagNameAttr == "*" && starTag == null) {
                starTag = h;
            }
        }
        if (starTag != null) {
            return starTag;
        }
        if (!hasPages) {
            return htmlobj;
        }
        return null;
    }

    findComponent(componentName : string) : any {
        let htmlobj = this.HtmlObj.get();
        if (htmlobj == null || htmlobj.list == null) {
            return null;
        }
        for (let h of htmlobj.list) {
            if (h.tag == "define-component" && h.attrs != null && h.attrs["name"] == componentName) {
                return h;
            }
        }
        return null;
    }

    findLocalHandler(handlerName : string) : any {
        let htmlobj = this.HtmlObj.get();
        if (htmlobj == null || htmlobj.list == null) {
            return null;
        }
        for (let h of htmlobj.list) {
            if ((h.tag == "define-handler") && h.attrs != null && h.attrs["name"] == handlerName) {
                return h;
            }
        }
        return null;
    }

    // opts: rtContext, dataenv
    runLocalHandler(handlerHtml : any, handlerData : any[], opts? : any) : Promise<any> {
        if (opts == null) {
            opts = {};
        }
        let handlerText = textContent(handlerHtml);
        console.log("run local handler", handlerHtml, handlerText, handlerData);
        let rtctx = null;
        if (opts.rtContext != null) {
            rtctx = opts.rtContext;
        }
        if (rtctx == null) {
            rtctx = new RtContext();
        }
        let dataenv = opts.dataenv;
        if (dataenv == null) {
            dataenv = this.rootDataenv();
        }
        let htmlContext = sprintf("@local:%s", handlerHtml.attrs.name)
        let contextDataenv = dataenv.makeSpecialChildEnv({params: handlerData}, {htmlContext: htmlContext});
        rtctx.pushContext(sprintf("Running @local handler '%s'", handlerHtml.attrs.name));
        // TODO - use ParseBlockThrow / ExecuteBlockP to return a promise that can throw errors
        let p = DataCtx.ParseAndExecuteBlock(handlerText, null, contextDataenv, rtctx);
        return p;
    }

    findScript(scriptName : string) : any {
        let htmlobj = this.HtmlObj.get();
        if (htmlobj == null || htmlobj.list == null) {
            return null;
        }
        for (let h of htmlobj.list) {
            if ((h.tag == "script" || h.tag == "d-script") && h.attrs != null && h.attrs["name"] == scriptName) {
                return h;
            }
        }
        return null;
    }

    returnValueFromActions(rra : any) : any {
        return this.processActions(rra, true);
    }

    runActions(rra : HibikiAction[]) : any {
        return this.processActions(rra, false);
    }

    @mobx.action processActions(rra : any, pureRequest : boolean) : any {
        if (rra == null) {
            return null;
        }
        let rtnval = null;
        let dataenv = this.rootDataenv();
        for (let rr of rra) {
            let selector = rr.selector ?? rr.path;
            if (rr.type == "setdata" && selector == "@rtn") {
                rtnval = rr.data;
                continue;
            }
            else if (rr.type == "blob" && selector == "@rtn") {
                rtnval = DataCtx.BlobFromRRA(rr);
                continue;
            }
            else if (rr.type == "blobext" && selector == "@rtn") {
                if (rtnval == null || !(rtnval instanceof DataCtx.HibikiBlob)) {
                    console.log("Bad blobext:@rtn, no HibikiBlob to extend");
                    continue;
                }
                DataCtx.ExtBlobFromRRA(rtnval, rr);
                continue;
            }
            if (pureRequest) {
                continue;
            }
            if (rr.type == "invalidate") {
                this.invalidateRegex(selector);
            }
            else if (rr.type == "html") {
                let htmlObj = parseHtml(rr.data);
                if (htmlObj != null) {
                    this.HtmlObj.set(htmlObj);
                }
                console.log("PARSE NEW HTML", htmlObj, DataCtx.demobx(this.HtmlObj.get()));
            }
            DataCtx.ApplySingleRRA(dataenv, rr);
        }
        return rtnval;
    }

    // opts: rtContext, dataenv
    async callHandlerInternalAsync(handlerPath : string, handlerData : any[], pureRequest : boolean, opts? : any) : Promise<any> {
        opts = opts || {};
        if (handlerPath == null || handlerPath == "") {
            throw "Invalid handler path"
        }
        let hpath = parseHandler(handlerPath);
        if (hpath == null) {
            throw "Invalid handler path: " + handlerPath;
        }
        let moduleName = hpath.ns ?? "default";
        let module = this.Modules[moduleName];
        if (module == null) {
            throw sprintf("Invalid handler, no module '%s' found for path: %s", moduleName, handlerPath);
        }
        let req : RequestType = {
            path: {
                module: moduleName,
                path: hpath.path,
                pathfrag: hpath.pathfrag,
            },
            data: handlerData,
            rtContext: opts.rtContext,
            state: this.getExtState(),
            pure : pureRequest,
        };
        let self = this;
        let rtnp = module.callHandler(req);
        return rtnp.then((data) => {
            if (data == null || typeof(data) != "object" || !("hibikiactions" in data) || !Array.isArray(data.hibikiactions)) {
                return data;
            }
            return self.processActions(data.hibikiactions, pureRequest);
        });
    }

    callHandler(handlerPath : string, handlerData : any[], opts? : {rtContext? : RtContext}) : Promise<any> {
        opts = opts || {};
        let self = this;
        let handlerP = this.callHandlerInternalAsync(handlerPath, handlerData, false);
        let prtn = handlerP.catch((e) => {
            let errObj = new HibikiError(sprintf("Error calling handler %s", handlerPath), e, opts.rtContext);
            self.reportErrorObj(errObj);
        });
        return prtn;
    }

    callData(handlerPath : string, handlerData : any[], opts? : {rtContext? : RtContext}) : Promise<any> {
        let self = this;
        let handlerP = this.callHandlerInternalAsync(handlerPath, handlerData, true);
        let prtn = handlerP.catch((e) => {
            let errObj = new HibikiError(sprintf("Error calling data handler %s", handlerPath), e, opts.rtContext);
            self.reportErrorObj(errObj);
        });
        return prtn;
    }

    reportError(errorMessage : string, rtctx? : RtContext) {
        let err = new HibikiError(errorMessage, null, rtctx);
        this.reportErrorObj(err);
    }

    reportErrorObj(errorObj : HibikiError) {
        if (this.ErrorCallback == null) {
            console.log(errorObj.toString());
            return;
        }
        this.ErrorCallback(errorObj);
    }

    registerDataNodeState(uuid : string, query : string, dnstate : any) {
        this.DataNodeStates[uuid] = {query: query, dnstate: dnstate};
    }

    unregisterDataNodeState(uuid : string) {
        delete this.DataNodeStates[uuid];
    }

    @mobx.action invalidate(query : string) {
        for (let uuid in this.DataNodeStates) {
            let dnq = this.DataNodeStates[uuid];
            if (dnq.query != query) {
                continue;
            }
            dnq.dnstate.forceRefresh();
        }
    }

    @mobx.action invalidateRegex(queryReStr : string) {
        let queryRe = new RegExp(queryReStr);
        for (let uuid in this.DataNodeStates) {
            let dnq = this.DataNodeStates[uuid];
            if (!dnq.query.match(queryRe)) {
                continue;
            }
            dnq.dnstate.forceRefresh();
        }
    }

    @mobx.action invalidateAll() {
        for (let uuid in this.DataNodeStates) {
            let dnq = this.DataNodeStates[uuid];
            dnq.dnstate.forceRefresh();
        }
    }

    queueScriptSrc(scriptSrc : string, sync : boolean) {
        // console.log("queue script src", scriptSrc);
        let srcMd5 = md5(scriptSrc);
        if (this.ScriptCache[srcMd5]) {
            return;
        }
        this.ScriptCache[srcMd5] = true;
        let scriptElem = document.createElement("script");
        if (sync) {
            scriptElem.async = false;
        }
        scriptElem.src = scriptSrc;
        document.querySelector("body").appendChild(scriptElem);
    }

    queueScriptText(text : string, sync : boolean) {
        // console.log("queue script", text);
        let textMd5 = md5(text);
        if (this.ScriptCache[textMd5]) {
            return;
        }
        this.ScriptCache[textMd5] = true;
        let dataUri = "data:text/javascript;base64," + btoa(text);
        this.queueScriptSrc(dataUri, sync);
    }
}

const STYLE_UNITLESS_NUMBER = { // from react
    "animation-iteration-count": true,
    "border-image-outset": true,
    "border-image-slice": true,
    "border-image-width": true,
    "box-flex": true,
    "box-flex-group": true,
    "box-ordinal-group": true,
    "column-count": true,
    columns: true,
    flex: true,
    "flex-grow": true,
    "flex-positive": true,
    "flex-shrink": true,
    "flex-negative": true,
    "flex-order": true,
    "grid-row": true,
    "grid-row-end": true,
    "grid-row-span": true,
    "grid-row-start": true,
    "grid-column": true,
    "grid-column-end": true,
    "grid-column-span": true,
    "grid-column-start": true,
    "font-weight": true,
    "line-clamp": true,
    "line-height": true,
    opacity: true,
    order: true,
    orphans: true,
    tabsize: true,
    widows: true,
    "z-index": true,
    zoom: true,

    // svg-related properties
    "fill-opacity": true,
    "flood-opacity": true,
    "stop-opacity": true,
    "stroke-dasharray": true,
    "stroke-dashoffset": true,
    "stroke-miterlimit": true,
    "stroke-opacity": true,
    "stroke-width": true,
};

// return type is not necessarily string :/
function resolveAttrVal(k : string, v : string, dataenv : DataEnvironment, opts : any) : string {
    opts = opts || {};
    if (v == null || v == "") {
        return null;
    }
    if (!v.startsWith("*")) {
        return v;
    }
    v = v.substr(1);
    let rtContext = opts.rtContext || sprintf("Resolving Attribute '%s'", k);
    let resolvedVal = DataCtx.EvalSimpleExpr(v, dataenv, rtContext);
    if (resolvedVal instanceof DataCtx.LValue) {
        resolvedVal = resolvedVal.get();
    }
    if (opts.raw) {
        return resolvedVal;
    }
    if (resolvedVal == null || resolvedVal === false || resolvedVal == "") {
        return null;
    }
    if (resolvedVal === true) {
        resolvedVal = 1;
    }
    if (k == "blobsrc" && resolvedVal instanceof DataCtx.HibikiBlob) {
        return (resolvedVal as any);
    }
    if (opts.style && typeof(resolvedVal) == "number") {
        if (!STYLE_UNITLESS_NUMBER[k]) {
            resolvedVal = String(resolvedVal) + "px";
        }
    }
    return String(resolvedVal);
}

function getAttributes(node : HibikiNode, dataenv : DataEnvironment, opts? : any) : any {
    if (node.attrs == null) {
        return {};
    }
    opts = opts || {};
    let rtn = {};
    for (let [k,v] of Object.entries(node.attrs)) {
        opts.rtContext = sprintf("Resolving attribute '%s' in <%s>", k, node.tag);
        let rval = resolveAttrVal(k, v, dataenv, opts);
        if (rval == null) {
            continue;
        }
        rtn[k] = rval;
    }
    return rtn;
}

function getAttribute(node : HibikiNode, attrName : string, dataenv : DataEnvironment, opts? : any) : any {
    if (!node || !node.attrs || node.attrs[attrName] == null) {
        return null;
    }
    opts = opts || {};
    opts.rtContext = sprintf("Resolving attribute '%s' in <%s>", attrName, node.tag);
    let val = node.attrs[attrName];
    let rval = resolveAttrVal(attrName, val, dataenv, opts);
    if (rval == null) {
        return null;
    }
    return rval;
}

const STYLE_KEY_MAP = {
    "bold": {key: "fontWeight", val: "bold"},
    "italic": {key: "fontStyle", val: "italic"},
    "underline": {key: "textDecoration", val: "underline"},
    "strike": {key: "textDecoration", val: "line-through"},
    "pre": {key: "whiteSpace", val: "pre"},
    "fixedfont": {key: "fontFamily", val: "\"courier new\", fixed"},
    "grow": {key: "flex", val: "1 0 0"},
    "noshrink": {key: "flexShrink", val: "0"},
    "shrink": {key: "flexShrink", val: "1"},
    "scroll": {key: "overflow", val: "scroll"},
    "center": {flex: true, key: "justifyContent", val: "center"},
    "xcenter": {flex: true, key: "alignItems", val: "center"},
    "fullcenter": {flex: true},
};

function getStyleMap(node : HibikiNode, styleName : string, dataenv : DataEnvironment, initStyles? : any) : any {
    let rtn = initStyles || {};
    let styleMap : {[v : string] : string}= null;
    if (styleName == "style") {
        styleMap = node.style;
    } else {
        if (node.morestyles != null) {
            styleMap = node.morestyles[styleName];
        }
    }
    if (styleMap == null) {
        return rtn;
    }
    for (let [k,v] of Object.entries(styleMap)) {
        let opts = {
            style: true,
            rtContext: sprintf("Resolve style property '%s' in attribute '%s' in <%s>", k, styleName, node.tag),
        };
        let rval = resolveAttrVal(k, v, dataenv, opts);
        if (rval == null) {
            continue;
        }
        let skm = STYLE_KEY_MAP[k];
        if (skm != null) {
            if (skm.flex) {
                rtn.display = "flex";
            }
            if (k == "fullcenter") {
                rtn.justifyContent = "center";
                rtn.alignItems = "center";
                continue;
            }
            rtn[skm.key] = skm.val;
            continue;
        }
        rtn[k] = rval;
    }
    return rtn;
}

function parseHandler(handlerPath : string) : HandlerPathObj {
    if (handlerPath == null || handlerPath == "" || handlerPath[0] != '/') {
        return null;
    }
    let match = handlerPath.match("^(?:/@([a-zA-Z_][a-zA-Z0-9_]*))?(/[a-zA-Z0-9._/-]*)?(?:[:](@?[a-zA-Z][a-zA-Z0-9_-]*))?$")
    if (match == null) {
        return null;
    }
    return {ns: (match[1] ?? ""), path: (match[2] ?? "/"), pathfrag: (match[3] ?? "")};
}

function hasHtmlRR(rra : any[]) : boolean {
    if (rra == null) {
        return false;
    }
    for (let i=0; i<rra.length; i++) {
        let rr = rra[i];
        if (rr.type == "html") {
            return true;
        }
    }
    return false;
}

export {HibikiState, DataEnvironment, getAttributes, getAttribute, getStyleMap, HibikiExtState};
