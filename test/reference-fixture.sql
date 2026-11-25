CREATE TABLE mec_aircraft (sheet_order INTEGER NOT NULL, aircraft_row INTEGER NOT NULL, sheet TEXT NOT NULL, aircraft TEXT NOT NULL, climb_ias_100_percent_kmh INTEGER, climb_ias_wep_kmh INTEGER, PRIMARY KEY (sheet_order, aircraft_row));
INSERT INTO mec_aircraft VALUES (4, 93, 'USAAFUSAF', 'P-51', 230, 240);
INSERT INTO mec_aircraft VALUES (8, 123, 'Messerschmitt', 'Bf 109 G-6', 240, NULL);
INSERT INTO mec_aircraft VALUES (19, 3, 'Spitfire', 'Spitfire Mk Ia', 200, 210);
INSERT INTO mec_aircraft VALUES (31, 63, 'Armée de lair', 'D.520', 220, 230);
