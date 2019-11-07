import { Debugger, Session } from "inspector";
import { promisify } from "util";
import { v4 } from "uuid";

import { CacheManager, ILocation } from "./cache-amanger.class";
import { Deferred } from "./deffered.class";
const PREFIX = "__functionLocation__";

export class SessionManager {
  private cache: CacheManager = new CacheManager();
  private session: (Session | undefined);
  private post$;
  private scripts: {
    [scriptId: string]: Debugger.ScriptParsedEventDataType;
  } = {};

  public async clean(): Promise<boolean> {
    if (!this.session) {
      return true;
    }

    await this.post$("Runtime.releaseObjectGroup", {
      objectGroup: PREFIX,
    });

    this.session.disconnect();
    delete global[PREFIX];
    this.session = undefined;
    this.cache.clear();

    return true;
  }

  public async locate(fn: (...args: any) => any): Promise<ILocation> {
    if (typeof fn !== "function") {
      throw new Error("You are allowed only to reference functions.");
    }

    // Look from the function inside the cache array and return it if it does exist.
    const fromCache = await this.cache.get(fn);

    if (fromCache) {
      return await fromCache.location.promise;
    }

    const deferred = new Deferred<ILocation>();

    // Push a deffered location into the cache
    this.cache.add({ ref: fn, location: deferred });

    // Create a function location object to put referencies into it
    // So that we can easilly access to them
    if (typeof global[PREFIX] === "undefined") {
      global[PREFIX] = {};
    }

    // Create a reference of the function inside the global object
    const uuid = v4();
    global[PREFIX][uuid] = fn;

    // Create an inspector session an enable the debugger inside it
    if (!this.session) {
      this.session = new Session();
      this.post$ = promisify(this.session.post).bind(this.session);
      this.session.connect();
      this.session.on("Debugger.scriptParsed", (res) => {
        this.scripts[res.params.scriptId] = res.params;
      });
      await this.post$("Debugger.enable");
    }

    // Evaluate the expression
    const evaluated = await this.post$("Runtime.evaluate", {
      expression: `global['${PREFIX}']['${uuid}']`,
      objectGroup: PREFIX,
    });

    // Get the function properties
    const properties = await this.post$("Runtime.getProperties", {
      objectId: evaluated.result.objectId,
    });

    const location = properties.internalProperties.find((prop) => prop.name === "[[FunctionLocation]]");
    const script = this.scripts[location.value.value.scriptId];
    let source = script.url;

    // Normalize the source uri to ensure consistent result
    if (!source.startsWith("file://")) {
      source = `file://${source}`;
    }

    // Construct the result object
    const result: ILocation = {
      column: location.value.value.columnNumber + 1,
      line: location.value.value.lineNumber + 1,
      source,
    };

    // Resolve the defered variable
    deferred.resolve(result);

    // return the result
    return result;
  }
}