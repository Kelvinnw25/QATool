import { createContext, useContext } from 'react';

import { config } from '../config.js';

/**
 * The build's configuration, as a context so a test can render a page as the public demo (or as
 * the local tool) without rebuilding anything. The default is the real, frozen build config.
 */
export const ConfigContext = createContext(config);

export function useConfig() {
  return useContext(ConfigContext);
}
