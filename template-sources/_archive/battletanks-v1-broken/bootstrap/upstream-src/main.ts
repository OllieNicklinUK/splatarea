import { World } from "./World";

interface CustomWindow extends Window {
  world: World;
}

declare let window: CustomWindow;

function main() {
  const world = new World();
  window.world = world;
}

main();
