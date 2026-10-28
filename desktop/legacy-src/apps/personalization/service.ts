import type { PersistenceService, UiPreferences } from "../../core/persistence/service";

export interface PersonalizationService {
  read(): UiPreferences;
  write(preferences: UiPreferences): boolean;
}

export function createPersonalizationService(persistence: PersistenceService): PersonalizationService {
  const service: PersonalizationService = {
    read: () => persistence.readUiPreferences(),
    write: (preferences: UiPreferences) => persistence.writeUiPreferences(preferences),
  };
  return Object.freeze(service);
}
