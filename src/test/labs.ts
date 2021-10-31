import { DeviceTreeCompile } from "../DeviceTreeCompile";

// native can use absolute path
//const filePath = "/home/castello/tmp/dts-python-labs/devicetree-source/src/arm/foo.dts";
//const includesPath = "/home/castello/tmp/dts-python-labs/devicetree-source/include";

// docker have to be relative to workdir /bindmount
const filePath = "src/arm/foo.dts";
const includesPath = "include";
const bindmount = "/home/castello/tmp/dts-python-labs/devicetree-source";

console.log("Let's compile");

let dtc = new DeviceTreeCompile(filePath, includesPath, true, bindmount);

dtc.onError(diags => {
    diags.forEach(diag => {
        console.log(diag);
        console.log(`Error at ${diag.file} line ${diag.line} cause ${diag.cause}`);
    });
});

dtc.compile();
