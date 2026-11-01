import { Circle, format } from "./shapes";
import { sum } from "./util.js";

function main(): number {
  const circle = new Circle(2);
  console.log(circle.describe());
  return sum([circle.area(), circle.area()]);
}

main();

export function unused(): string {
  return format(1);
}
