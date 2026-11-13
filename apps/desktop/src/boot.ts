import { runNeoPiCli } from "./neopi/NeoPiCli.ts";

if (!runNeoPiCli()) {
  require("./compileCache.cjs");
  require("./main.cjs");
}
