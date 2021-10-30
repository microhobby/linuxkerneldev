import { DeviceTreeCompile } from "../DeviceTreeCompile";

const filePath = "/home/castello/tmp/dts-python-labs/devicetree-source/src/arm/foo.dts";
const includesPath = "/home/castello/tmp/dts-python-labs/devicetree-source/include";

console.log("Let's compile");

let dtc = new DeviceTreeCompile(filePath, includesPath);

dtc.onError(diags => {
    diags.forEach(diag => {
        console.log(diag);
        console.log(`Error at ${diag.file} line ${diag.line} cause ${diag.cause}`);
    });
});

dtc.compile();
