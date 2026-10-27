/**
 * PTTButton.tsx — Push-To-Talk button
 * Hold to talk, release to stop transmitting.
 * Shows pulsing glow ring while active.
 */

import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { COLORS } from "../constants";

interface PTTButtonProps {
  onPressIn: () => void;
  onPressOut: () => void;
  transmitting: boolean;
  disabled?: boolean;
}

export function PTTButton({ onPressIn, onPressOut, transmitting, disabled }: PTTButtonProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (transmitting) {
      // Pulsing scale animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.12,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      ).start();
      // Glow fade-in
      Animated.timing(glowAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      pulseAnim.stopAnimation();
      Animated.timing(pulseAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
      Animated.timing(glowAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [transmitting, pulseAnim, glowAnim]);

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.5],
  });

  return (
    <View style={styles.wrapper}>
      {/* Glow ring */}
      <Animated.View
        style={[
          styles.glowRing,
          { opacity: glowOpacity, transform: [{ scale: pulseAnim }] },
        ]}
      />
      {/* Outer pulse ring */}
      <Animated.View
        style={[
          styles.pulseRing,
          { transform: [{ scale: pulseAnim }], opacity: transmitting ? 0.3 : 0 },
        ]}
      />
      {/* Main button */}
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <Pressable
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            transmitting && styles.buttonActive,
            pressed && styles.buttonPressed,
            disabled && styles.buttonDisabled,
          ]}
        >
          {/* Mic icon (unicode) */}
          <Text style={[styles.icon, transmitting && styles.iconActive]}>
            {transmitting ? "🔴" : "🎙️"}
          </Text>
          <Text style={[styles.label, transmitting && styles.labelActive]}>
            {transmitting ? "TALKING" : "HOLD TO TALK"}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const BUTTON_SIZE = 160;

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
    width: BUTTON_SIZE + 80,
    height: BUTTON_SIZE + 80,
  },
  glowRing: {
    position: "absolute",
    width: BUTTON_SIZE + 60,
    height: BUTTON_SIZE + 60,
    borderRadius: (BUTTON_SIZE + 60) / 2,
    backgroundColor: COLORS.primary,
  },
  pulseRing: {
    position: "absolute",
    width: BUTTON_SIZE + 40,
    height: BUTTON_SIZE + 40,
    borderRadius: (BUTTON_SIZE + 40) / 2,
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    // Shadow
    ...Platform.select({
      ios: {
        shadowColor: COLORS.primary,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0,
        shadowRadius: 20,
      },
    }),
  },
  buttonActive: {
    backgroundColor: "#1A1040",
    borderColor: COLORS.primary,
    ...Platform.select({
      ios: { shadowOpacity: 0.8 },
    }),
  },
  buttonPressed: {
    backgroundColor: "#1A1040",
    borderColor: COLORS.primary,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  icon: {
    fontSize: 36,
  },
  iconActive: {},
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    color: COLORS.textSecondary,
  },
  labelActive: {
    color: COLORS.primary,
  },
});
