import { mount } from "svelte";

import App from "./App.svelte";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/shell.css";

const target = document.querySelector<HTMLElement>("#app");
if (!target) throw new Error("ImageWeave mount target is missing");

mount(App, { target });
