// Mobile entry: install the platform shim, load the shared softphone styles,
// then import the shared renderer (which mounts the app). Import order matters —
// the shim must run before the renderer reads window.__XELO_MOBILE__.
import "../../desktop/src/renderer/styles.css";
import "./shim";
import "../../desktop/src/renderer/renderer";
