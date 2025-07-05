export class Knowledge {
  private familyRelations = new Map<string, string>([
    ['anjali', 'daughter'],
    ['christopher', 'daughter'],
    ['zara', 'younger sister'],
    ['samira', 'older sister'],
    ['ellena', 'older sister'],
    ['helge', 'granddaughter'],
    ['christine', 'granddaughter'],
    ['lennard', 'niece'],
    ['jonas', 'niece']
  ]);

  private userAges = new Map<string, number>([
    ['anjali', 36],
    ['christopher', 36],
    ['zara', 13],
    ['samira', 5],
    ['ellena', 2],
    ['helge', 57],
    ['christine', 56],
    ['lennard', 34],
    ['jonas', 29]
  ]);

  getFamilyRelationTo(username: string): string {
    return this.familyRelations.get(username) ?? 'distant relative';
  }

  getAgeOf(username: string): number {
    return this.userAges.get(username) ?? 30;
  }
}
