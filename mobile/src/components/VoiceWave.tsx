/**
 * VoiceWave.tsx — Animated audio waveform displayed around the PTT button.
 * Shows animated bars when transmitting or receiving audio.
 */

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { COLORS } from "../constants";

interface VoiceWaveProps {
  active: boolean;          // true = animate bars
  color?: string;
  barCount?: number;
}

export function VoiceWave({ active, color = COLORS.primary, barCount = 5 }: VoiceWaveProps) {
  const anims = useRef(
    Array.from({ length: barCount }, () => new Animated.Value(0.3))
  ).current;

  useEffect(() => {
    if (active) {
      const animations = anims.map((anim, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 80),
            Animated.timing(anim, {
              toValue: 1,
              duration: 400,
              useNativeDriver: true,
            }),
            Animated.timing(anim, {
              toValue: 0.3,
              duration: 400,
              useNativeDriver: true,
            }),
          ])
        )
      );
      Animated.parallel(animations).start();
    } else {
      anims.forEach((anim) => {
        anim.stopAnimation();
        Animated.timing(anim, {
          toValue: 0.3,
          duration: 200,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [active, anims]);

  return (
    <View style={styles.container}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: color,
              transform: [{ scaleY: anim }],
              opacity: anim,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 40,
  },
  bar: {
    width: 4,
    height: 30,
    borderRadius: 2,
  },
});
