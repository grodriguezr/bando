/** Contrato común de todas las figuras. */
export interface Shape {
  area(): number;
}

export abstract class Base implements Shape {
  abstract area(): number;

  describe(): string {
    return `${this.constructor.name}: ${format(this.area())}`;
  }
}

export class Circle extends Base {
  constructor(private readonly radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius ** 2;
  }
}

export const format = (n: number): string => n.toFixed(2);
